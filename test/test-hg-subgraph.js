const assert = require('assert')
const axios = require('axios')
const delay = require('delay');
const TruffleContract = require('truffle-contract')
const PredictionMarketSystem = TruffleContract(require('@gnosis.pm/hg-contracts/build/contracts/PredictionMarketSystem.json'))

async function waitForGraphSync(targetBlockNumber) {
        do { await delay(10) }
        while((await axios.post('http://127.0.0.1:8000/subgraphs', {
            query: '{subgraphVersions(orderBy:createdAt orderDirection:desc first:1){deployment{latestEthereumBlockNumber}}}',
        })).data.data.subgraphVersions[0].deployment.latestEthereumBlockNumber < targetBlockNumber);
}

describe('hg-subgraph', function() {
    let accounts, predictionMarketSystem, web3

    before(async () => {
        PredictionMarketSystem.setProvider('http://localhost:8545')
        web3 = PredictionMarketSystem.web3
        accounts = await web3.eth.getAccounts()
        web3.eth.defaultAccount = accounts[0]
        predictionMarketSystem = await PredictionMarketSystem.deployed()
    })

    it('matches the configuration', async () => {
        assert.equal(predictionMarketSystem.address, '0xCfEB869F69431e42cdB54A4F4f105C19C080A601')
    })

    it('allows GraphQL queries', async () => {
        assert((await axios.post('http://127.0.0.1:8000/subgraphs/name/InfiniteStyles/exampleGraph', {
            operationName: null,
            query: '{conditions(first:1){id}}',
            variables: null,
        })).data.data.conditions)
    })

    it('will index conditions upon preparation and update them upon resolution', async () => {
        const [creator, oracle] = accounts
        const questionId = web3.utils.randomHex(32)
        const outcomeSlotCount = 3
        const conditionId = web3.utils.soliditySha3(
            { type: 'address', value: oracle },
            { type: 'bytes32', value: questionId },
            { type: 'uint', value: outcomeSlotCount },
        )
        let targetBlockNumber = (await predictionMarketSystem.prepareCondition(oracle, questionId, outcomeSlotCount, { from: creator })).receipt.blockNumber

        await waitForGraphSync(targetBlockNumber)

        let { condition } = (await axios.post('http://127.0.0.1:8000/subgraphs/name/InfiniteStyles/exampleGraph', {
            query: `{
                condition(id:"${conditionId}"){
                    creator
                    oracle
                    questionId
                    outcomeSlotCount
                    resolved
                    payoutNumerators
                    payoutDenominator
                }
            }`,
        })).data.data

        assert(condition, 'condition not found')
        assert.equal(condition.creator, creator.toLowerCase())
        assert.equal(condition.oracle, oracle.toLowerCase())
        assert.equal(condition.questionId, questionId)
        assert.equal(condition.outcomeSlotCount, outcomeSlotCount)
        assert(!condition.resolved)
        assert.equal(condition.payoutNumerators, null)
        assert.equal(condition.payoutDenominator, null)

        targetBlockNumber = (await predictionMarketSystem.receiveResult(questionId, '0x000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000000', { from: oracle })).receipt.blockNumber

        await waitForGraphSync(targetBlockNumber)

        condition = (await axios.post('http://127.0.0.1:8000/subgraphs/name/InfiniteStyles/exampleGraph', {
            query: `{
                condition(id:"${conditionId}"){
                    resolved
                    payoutNumerators
                    payoutDenominator
                }
            }`,
        })).data.data.condition

        assert(condition.resolved)
        assert.equal(condition.payoutDenominator, 1)
        const expectedNumerators = [0, 1, 0]
        condition.payoutNumerators.forEach((num, i) => assert.equal(num, expectedNumerators[i]))
    })
})
