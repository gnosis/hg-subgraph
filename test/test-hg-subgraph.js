const assert = require('assert')
const axios = require('axios')
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
        const questionId = '0x0000000000000000000000000000000000000000000000000000000000000000'
        const outcomeSlotCount = 3
        const conditionId = web3.utils.soliditySha3(
            { type: 'address', value: oracle },
            { type: 'bytes32', value: questionId },
            { type: 'uint', value: outcomeSlotCount },
        )
        // await predictionMarketSystem.prepareCondition(oracle, questionId, outcomeSlotCount)
        console.log((await axios.post('http://127.0.0.1:8000/subgraphs/name/InfiniteStyles/exampleGraph', {
            operationName: null,
            query: '{conditions(first:1){id}}',
            variables: null,
        })).data.data.conditions)
    })
})
