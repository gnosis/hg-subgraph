const assert = require('assert')
const axios = require('axios')
const delay = require('delay');
const TruffleContract = require('truffle-contract')
const PredictionMarketSystem = TruffleContract(require('@gnosis.pm/hg-contracts/build/contracts/PredictionMarketSystem.json'))
const ERC20Mintable = TruffleContract(require('openzeppelin-solidity/build/contracts/ERC20Mintable.json'))
;[PredictionMarketSystem, ERC20Mintable].forEach(C => C.setProvider('http://localhost:8545'))
const web3 = PredictionMarketSystem.web3

async function waitForGraphSync(targetBlockNumber) {
    if(targetBlockNumber == null)
        targetBlockNumber = await web3.eth.getBlockNumber()

    do { await delay(100) }
    while((await axios.post('http://127.0.0.1:8000/subgraphs', {
        query: '{subgraphVersions(orderBy:createdAt orderDirection:desc first:1){deployment{latestEthereumBlockNumber}}}',
    })).data.data.subgraphVersions[0].deployment.latestEthereumBlockNumber < targetBlockNumber);
}

describe('hg-subgraph', function() {
    this.timeout(5000)
    let accounts, predictionMarketSystem, collateralToken, minter

    before(async function() {
        this.timeout(30000)
        accounts = await web3.eth.getAccounts()
        web3.eth.defaultAccount = minter = accounts[0]
        predictionMarketSystem = await PredictionMarketSystem.deployed()
        collateralToken = await ERC20Mintable.new({ from: minter })
        await waitForGraphSync()
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
        await predictionMarketSystem.prepareCondition(oracle, questionId, outcomeSlotCount, { from: creator })

        await waitForGraphSync()

        let { condition } = (await axios.post('http://127.0.0.1:8000/subgraphs/name/InfiniteStyles/exampleGraph', {
            query: `{
                condition(id:"${conditionId}") {
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

        await predictionMarketSystem.receiveResult(questionId, '0x000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000000', { from: oracle })

        await waitForGraphSync()

        condition = (await axios.post('http://127.0.0.1:8000/subgraphs/name/InfiniteStyles/exampleGraph', {
            query: `{
                condition(id: "${conditionId}") {
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

    it('will collect info from splitting and merging positions', async () => {
        const [creator, oracle, trader] = accounts
        const conditionsInfo = Array.from({ length: 3 }, () => {
            const questionId = web3.utils.randomHex(32)
            const outcomeSlotCount = 34
            const conditionId = web3.utils.soliditySha3(
                { type: 'address', value: oracle },
                { type: 'bytes32', value: questionId },
                { type: 'uint', value: outcomeSlotCount },
            )
            return { questionId, outcomeSlotCount, conditionId }
        })

        await Promise.all(conditionsInfo.map(({ questionId, outcomeSlotCount }) =>
            predictionMarketSystem.prepareCondition(oracle, questionId, outcomeSlotCount, { from: creator })
        ))

        await collateralToken.mint(trader, 100, { from: minter })
        assert.equal(await collateralToken.balanceOf(trader), 100)

        await collateralToken.approve(predictionMarketSystem.address, 100, { from: trader })
        const partition = [0b1010101010101010101011111111111111, 0b0101010101010101010100000000000000]
        await predictionMarketSystem.splitPosition(collateralToken.address, '0x0000000000000000000000000000000000000000000000000000000000000000', conditionsInfo[0].conditionId, partition, 100, { from: trader })

        const collectionIds = partition.map(indexSet => web3.utils.soliditySha3(
            { type: 'bytes32', value: conditionsInfo[0].conditionId },
            { type: 'uint', value: indexSet },
        ))

        const positionIds = collectionIds.map(collectionId => web3.utils.soliditySha3(
            { type: 'address', value: collateralToken.address },
            { type: 'bytes32', value: collectionId },
        ))

        assert.equal(await collateralToken.balanceOf(trader), 0)

        await waitForGraphSync()

        for(const collectionId of collectionIds) {
            const { collection } = (await axios.post('http://127.0.0.1:8000/subgraphs/name/InfiniteStyles/exampleGraph', {
                query: `{
                    collection(id: "${collectionId}") {
                        id
                        testValue
                    }
                }`,
            })).data.data
            assert(collection, `collection ${collectionId} not found`)
            console.log(collectionId, 'vs', collection.testValue)
        }

        for(const positionId of positionIds) {
            assert.equal(await predictionMarketSystem.balanceOf(trader, positionId), 100)
            const { position } = (await axios.post('http://127.0.0.1:8000/subgraphs/name/InfiniteStyles/exampleGraph', {
                query: `{
                    position(id: "${positionId}") {
                        id
                        collateralToken
                        testValue
                    }
                }`,
            })).data.data

            assert(position, `position ${positionId} not found`)
            assert.equal(position.collateralToken, collateralToken.address.toLowerCase())
            console.log(positionId, 'vs', position.testValue)
        }
    })
})
