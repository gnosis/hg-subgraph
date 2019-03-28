const assert = require('assert')
const axios = require('axios')
const delay = require('delay');
const TruffleContract = require('truffle-contract')
const PredictionMarketSystem = TruffleContract(require('@gnosis.pm/hg-contracts/build/contracts/PredictionMarketSystem.json'))

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

    it('will index conditions upon preparation', async () => {
        const [oracle] = accounts
        const questionId = web3.utils.randomHex(32)
        const outcomeSlotCount = 3
        const conditionId = web3.utils.soliditySha3(
            { type: 'address', value: oracle },
            { type: 'bytes32', value: questionId },
            { type: 'uint', value: outcomeSlotCount },
        )
        const targetBlockNumber = ((await predictionMarketSystem.prepareCondition(oracle, questionId, outcomeSlotCount)).receipt.blockNumber)

        do { await delay(10) }
        while((await axios.post('http://127.0.0.1:8000/subgraphs', {
            operationName: null,
            query: '{subgraphDeployments{latestEthereumBlockNumber}}',
            variables: null,
        })).data.data.subgraphDeployments[0].latestEthereumBlockNumber < targetBlockNumber);

        const { condition } = (await axios.post('http://127.0.0.1:8000/subgraphs/name/InfiniteStyles/exampleGraph', {
            operationName: null,
            query: `{condition(id:"${conditionId}"){oracle questionId outcomeSlotCount}}`,
            variables: null,
        })).data.data

        assert(condition, 'condition not found')
        assert.equal(condition.oracle, oracle.toLowerCase())
        assert.equal(condition.questionId, questionId)
        assert.equal(condition.outcomeSlotCount, outcomeSlotCount)
    })
})
