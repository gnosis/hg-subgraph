const assert = require('assert');
const axios = require('axios');
const delay = require('delay');
const { execSync, spawnSync } = require('child_process');
const TruffleContract = require('truffle-contract');
const PredictionMarketSystem = TruffleContract(
  require('@gnosis.pm/hg-contracts/build/contracts/PredictionMarketSystem.json')
);
const ERC20Mintable = TruffleContract(
  require('openzeppelin-solidity/build/contracts/ERC20Mintable.json')
);
[PredictionMarketSystem, ERC20Mintable].forEach(C => C.setProvider('http://localhost:8545'));
const web3 = PredictionMarketSystem.web3;
const { randomHex, soliditySha3, toHex, toBN, padLeft } = web3.utils;
const { log, error } = console;

async function waitForGraphSync(targetBlockNumber) {
  if (targetBlockNumber == null) {
    targetBlockNumber = await web3.eth.getBlockNumber();
  }

  do {
    await delay(100);
  } while (
    (await axios.post('http://127.0.0.1:8000/subgraphs', {
      query: `{subgraphs(orderBy:createdAt orderDirection:desc where: {name: "Gnosis/GnosisMarkets"}) { versions { deployment { latestEthereumBlockNumber }} } }`
    })).data.data.subgraphs[0].versions[0].deployment.latestEthereumBlockNumber < targetBlockNumber
  );
}

describe('hg-subgraph full interaction', function() {
  this.timeout(10000);
  let accounts, predictionMarketSystem, collateralToken, minter, globalConditions;

  before(async function() {
    this.timeout(30000);
    accounts = await web3.eth.getAccounts();
    const [minter, creator, oracle, trader1, trader2, newbie] = accounts;
    predictionMarketSystem = await PredictionMarketSystem.deployed();
    collateralToken = await ERC20Mintable.new({ from: minter });
    const conditionsInfo = Array.from({ length: 2 }, () => {
      const questionId = randomHex(32);
      const outcomeSlotCount = 3;
      const conditionId = soliditySha3(
        { type: 'address', value: oracle },
        { type: 'bytes32', value: questionId },
        { type: 'uint', value: outcomeSlotCount }
      );
      return { questionId, outcomeSlotCount, conditionId };
    });
    await predictionMarketSystem.prepareCondition(
      oracle,
      conditionsInfo[0].questionId,
      conditionsInfo[0].outcomeSlotCount,
      { from: creator }
    );
    await predictionMarketSystem.prepareCondition(
      oracle,
      conditionsInfo[1].questionId,
      conditionsInfo[1].outcomeSlotCount,
      { from: creator }
    );
    await predictionMarketSystem.receiveResult(
      conditionsInfo[0].questionId,
      '0x000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000000',
      { from: oracle }
    );
    globalConditions = conditionsInfo;
    await waitForGraphSync();
  });

  it('Should maintain correct Graph mappings as part of a complete scenario', async () => {
    const [minter, creator, oracle, trader1, trader2, newbie] = accounts;
    await collateralToken.mint(trader1, 100, { from: minter });
    assert.equal(await collateralToken.balanceOf(trader1), 100);
    await collateralToken.approve(predictionMarketSystem.address, 100, { from: trader1 });

    // Assert that Condition data is being stored properly
    const conditionGraphData = (await axios.post(
      `http://127.0.0.1:8000/subgraphs/name/Gnosis/GnosisMarkets`,
      {
        query: `{conditions(where: { id: "${
          globalConditions[0].conditionId
        }"}) { id oracle creator resolved outcomeSlotCount questionId payoutDenominator collections payoutNumerators}}`
      }
    )).data.data.conditions;
    assert(conditionGraphData[0]);
    assert.equal(conditionGraphData[0].id, globalConditions[0].conditionId);
    assert.equal(conditionGraphData[0].oracle, accounts[2].toLowerCase());
    assert.equal(conditionGraphData[0].creator, accounts[1].toLowerCase());
    assert.equal(conditionGraphData[0].resolved, true);
    assert.equal(conditionGraphData[0].outcomeSlotCount, 3);
    assert.equal(conditionGraphData[0].questionId, globalConditions[0].questionId);
    assert.equal(conditionGraphData[0].payoutDenominator, 1);
    assert.equal(conditionGraphData[0].payoutNumerators.length, 3);

    const partition = ['6', '1'];
    try {
      await predictionMarketSystem.splitPosition(
        collateralToken.address,
        '0x0000000000000000000000000000000000000000000000000000000000000000',
        globalConditions[0].conditionId,
        partition,
        50,
        { from: trader1 }
      );
      await waitForGraphSync();
    } catch (e) {
      console.log('message:', e.message);
    }
    const collectionIds = partition.map(indexSet =>
      soliditySha3(
        { type: 'bytes32', value: globalConditions[0].conditionId },
        { type: 'uint', value: indexSet }
      )
    );
    const positionIds = collectionIds.map(collectionId =>
      soliditySha3(
        { type: 'address', value: collateralToken.address },
        { type: 'bytes32', value: collectionId }
      )
    );

    // Assert that Collection data is being stored properly
    const collectionsGraphData = (await axios.post(
      `http://127.0.0.1:8000/subgraphs/name/Gnosis/GnosisMarkets`,
      {
        query: `{collections { id indexSets conditions { id }}}`
      }
    )).data.data;
  });
});
