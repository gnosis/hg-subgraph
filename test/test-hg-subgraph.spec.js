const assert = require('assert')
const axios = require('axios')
const delay = require('delay');
const TruffleContract = require('truffle-contract')
const PredictionMarketSystem = TruffleContract(require('@gnosis.pm/hg-contracts/build/contracts/PredictionMarketSystem.json'))
const ERC20Mintable = TruffleContract(require('openzeppelin-solidity/build/contracts/ERC20Mintable.json'))
;[PredictionMarketSystem, ERC20Mintable].forEach(C => C.setProvider('http://localhost:8545'))
const web3 = PredictionMarketSystem.web3
const { randomHex, soliditySha3, toHex, toBN, padLeft } = web3.utils

async function waitForGraphSync(targetBlockNumber) {
    if(targetBlockNumber == null)
        targetBlockNumber = await web3.eth.getBlockNumber()

    do { await delay(100) }
    while((await axios.post('http://127.0.0.1:8000/subgraphs', {
        query: '{subgraphVersions(orderBy:createdAt orderDirection:desc first:1){deployment{latestEthereumBlockNumber}}}',
    })).data.data.subgraphVersions[0].deployment.latestEthereumBlockNumber < targetBlockNumber);
}

describe('hg-subgraph conditions <> collections <> positions', function() {
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
        const questionId = randomHex(32)
        const outcomeSlotCount = 3
        const conditionId = soliditySha3(
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
        const conditionsInfo = Array.from({ length: 2 }, () => {
            const questionId = randomHex(32)
            const outcomeSlotCount = 68
            const conditionId = soliditySha3(
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
        const partition = ['0xffffffff000000000', '0x00000000fffffffff']
        await predictionMarketSystem.splitPosition(collateralToken.address, '0x0000000000000000000000000000000000000000000000000000000000000000', conditionsInfo[0].conditionId, partition, 100, { from: trader })

        const collectionIds = partition.map(indexSet => soliditySha3(
            { type: 'bytes32', value: conditionsInfo[0].conditionId },
            { type: 'uint', value: indexSet },
        ))

        const positionIds = collectionIds.map(collectionId => soliditySha3(
            { type: 'address', value: collateralToken.address },
            { type: 'bytes32', value: collectionId },
        ))

        assert.equal(await collateralToken.balanceOf(trader), 0)

        await waitForGraphSync()

        for(const [collectionId, indexSet] of collectionIds.map((c, i) => [c, partition[i]])) {
            const { collection } = (await axios.post('http://127.0.0.1:8000/subgraphs/name/InfiniteStyles/exampleGraph', {
                query: `{
                    collection(id: "${collectionId}") {
                        id
                        conditions { id }
                        indexSets
                    }
                }`,
            })).data.data
            assert(collection, `collection ${collectionId} not found`)
            assert.equal(collection.conditions.length, collection.indexSets.length)
            assert.equal(collection.conditions.length, 1)
            assert.equal(collection.conditions[0].id, conditionsInfo[0].conditionId)
            assert.equal(collection.indexSets[0], toBN(indexSet).toString())
        }

        for(const [positionId, collectionId] of positionIds.map((p, i) => [p, collectionIds[i]])) {
            assert.equal(await predictionMarketSystem.balanceOf(trader, positionId), 100)
            const { position } = (await axios.post('http://127.0.0.1:8000/subgraphs/name/InfiniteStyles/exampleGraph', {
                query: `{
                    position(id: "${positionId}") {
                        id
                        collateralToken
                        collection { id }
                    }
                }`,
            })).data.data

            assert(position, `position ${positionId} not found`)
            assert.equal(position.collection.id, collectionId)
        }

        const parentCollectionId2 = collectionIds[0]
        const parentCollectionId2BN = toBN(parentCollectionId2)
        await predictionMarketSystem.splitPosition(collateralToken.address, parentCollectionId2, conditionsInfo[1].conditionId, partition, 100, { from: trader })

        const collectionIds2 = partition.map(indexSet => padLeft(toHex(toBN(soliditySha3(
            { type: 'bytes32', value: conditionsInfo[1].conditionId },
            { type: 'uint', value: indexSet },
        )).add(parentCollectionId2BN).maskn(256))), 64);

        const positionIds2 = collectionIds2.map(collectionId => soliditySha3(
            { type: 'address', value: collateralToken.address },
            { type: 'bytes32', value: collectionId },
        ))

        await waitForGraphSync()

        for(const [collectionId, indexSet] of collectionIds2.map((c, i) => [c, partition[i]])) {
            const { collection } = (await axios.post('http://127.0.0.1:8000/subgraphs/name/InfiniteStyles/exampleGraph', {
                query: `{
                    collection(id: "${collectionId}") {
                        id
                        conditions { id }
                        indexSets
                    }
                }`,
            })).data.data
            assert(collection, `collection ${collectionId} not found`)
            assert.equal(collection.conditions.length, collection.indexSets.length)
            assert.equal(collection.conditions.length, 2)
            const parentIndex = collection.conditions.findIndex(({ id }) => id === conditionsInfo[0].conditionId)
            assert.notEqual(parentIndex, -1)
            // assert.equal(collection.indexSets[parentIndex], toBN(partition[0]).toString())
            const cIndex = collection.conditions.findIndex(({ id }) => id === conditionsInfo[1].conditionId)
            assert.notEqual(cIndex, -1)
            // assert.equal(collection.indexSets[cIndex], toBN(indexSet).toString())
        }

        for(const [positionId, collectionId] of positionIds2.map((p, i) => [p, collectionIds2[i]])) {
            assert.equal(await predictionMarketSystem.balanceOf(trader, positionId), 100)
            const { position } = (await axios.post('http://127.0.0.1:8000/subgraphs/name/InfiniteStyles/exampleGraph', {
                query: `{
                    position(id: "${positionId}") {
                        id
                        collateralToken
                        collection { id }
                    }
                }`,
            })).data.data

            assert(position, `position ${positionId} not found`)
            assert.equal(position.collateralToken, collateralToken.address.toLowerCase())
            assert.equal(position.collection.id, collectionId)
        }
    })
})
