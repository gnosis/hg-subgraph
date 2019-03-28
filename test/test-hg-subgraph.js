const assert = require('assert')
const axios = require('axios')
const TruffleContract = require('truffle-contract')
const PredictionMarketSystem = TruffleContract(require('@gnosis.pm/hg-contracts/build/contracts/PredictionMarketSystem.json'))

describe('hg-subgraph', function() {
    before(async () => {
        PredictionMarketSystem.setProvider('http://localhost:8545')
        await PredictionMarketSystem.detectNetwork()
    })

    it('matches the configuration', async () => {
        assert.equal(PredictionMarketSystem.address, '0xCfEB869F69431e42cdB54A4F4f105C19C080A601')
    })

    it('allows GraphQL queries', async () => {
        assert((await axios.post('http://127.0.0.1:8000/subgraphs/name/InfiniteStyles/exampleGraph', {
            operationName: null,
            query: '{conditions(first:1){id}}',
            variables: null,
        })).data.data.conditions)
    })
})
