const assert = require('assert')
const axios = require('axios')
const delay = require('delay');
const { execSync, spawnSync } = require("child_process");
const TruffleContract = require('truffle-contract')
const PredictionMarketSystem = TruffleContract(require('@gnosis.pm/hg-contracts/build/contracts/PredictionMarketSystem.json'))
const ERC20Mintable = TruffleContract(require('openzeppelin-solidity/build/contracts/ERC20Mintable.json'))
;[PredictionMarketSystem, ERC20Mintable].forEach(C => C.setProvider('http://localhost:8545'))
const web3 = PredictionMarketSystem.web3
const { randomHex, soliditySha3, toHex, toBN } = web3.utils
const { log, error } = console;

const SUBGRAPHNAME = "a" + randomHex(10);

(createAndDeployANewSubgraph = (name) => {
    try {
        execSync(`graph create InfiniteStyles/${name} --node http://127.0.0.1:8020`, { cwd: `/Users/antonvs/Projects/gnosis/hg-subgraph`});
        log(`Local subgraph ${name} has been created.`)    
    } catch(e) {
        console.log(`Couldn't create the subgraph with name: ${name}`);
    }

    try {
        execSync(`graph deploy InfiniteStyles/${name} --debug --ipfs http://localhost:5001 --node http://127.0.0.1:8020`, { cwd: `/Users/antonvs/Projects/gnosis/hg-subgraph`});
        log(`Local subgraph ${name} has been deployed.`)
    } catch(e) {
        console.log(`Couldn't deploy the subgraph with name: ${name}`);
    }
})(SUBGRAPHNAME);

async function waitForGraphSync(targetBlockNumber) {
    if(targetBlockNumber == null) {
        targetBlockNumber = await web3.eth.getBlockNumber()
    }

    do { await delay(100) }
    
    while((await axios.post('http://127.0.0.1:8000/subgraphs', {
        query: `{subgraphs(orderBy:createdAt orderDirection:desc where: {name: "InfiniteStyles/${SUBGRAPHNAME}"}) { versions { deployment { latestEthereumBlockNumber }} } }`,
    })).data.data.subgraphs[0].versions[0].deployment.latestEthereumBlockNumber < targetBlockNumber);
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

    it("Should keep a user position properly upon split", async () => {
      let [oracle, creator, user] = accounts;

      // create a position from collateral --> make sure split adds a user position to all User Positions

      // split a position from another collectionId --> make sure split adds the all the new UserPosition balances AND subtracts from the former UserPosition

      // split a position from a different position on the same condition --> make sure split subtracts correctly from the parentIndex and adds to the appropriate list of new indexes, make sure split doesn't add to the full index set

    });

    it("Should keep a User Position properly after a mergePositions", async () => {

    });

    it("Should keep a User Position properly after a redeemPositionss", async () => {

    });

    it("Should keep a User Positions after a TransferSingle", async () => {

    });

    it("Should keep track of user positions after a TransferBatch", async () => {

    });

  });