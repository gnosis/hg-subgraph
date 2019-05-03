const assert = require('assert');
const axios = require('axios');
const delay = require('delay');
const { execSync, spawnSync } = require('child_process');
const TruffleContract = require('truffle-contract');
const { add } = require('bn.js');
const PredictionMarketSystem = TruffleContract(
  require('@gnosis.pm/hg-contracts/build/contracts/PredictionMarketSystem.json')
);
const ERC20Mintable = TruffleContract(
  require('openzeppelin-solidity/build/contracts/ERC20Mintable.json')
);
[PredictionMarketSystem, ERC20Mintable].forEach(C => C.setProvider('http://localhost:8545'));
const web3 = PredictionMarketSystem.web3;
const { randomHex, soliditySha3, toHex, toBN, padLeft, keccak256 } = web3.utils;
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

describe('hg-subgraph UserPositions <> Positions.activeValue', function() {
  this.timeout(10000);
  let accounts,
    predictionMarketSystem,
    collateralToken,
    minter,
    globalConditionId,
    globalConditionId2;

  before(async function() {
    this.timeout(30000);
    accounts = await web3.eth.getAccounts();
    web3.eth.defaultAccount = minter = accounts[0];
    predictionMarketSystem = await PredictionMarketSystem.deployed();
    collateralToken = await ERC20Mintable.new({ from: minter });
    const [creator, oracle] = accounts;
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
    await predictionMarketSystem.receiveResult(
      conditionsInfo[1].questionId,
      '0x000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000000',
      { from: oracle }
    );
    globalConditionId = conditionsInfo[0].conditionId;
    globalConditionId2 = conditionsInfo[1].conditionId;
    await waitForGraphSync();
  });

  it('Should keep track of UserPositions and Users properly', async () => {
    const [creator, oracle, trader, trader2, newbie] = accounts;
    await collateralToken.mint(trader, 100, { from: minter });
    assert.equal(await collateralToken.balanceOf(trader), 100);
    await collateralToken.approve(predictionMarketSystem.address, 100, { from: trader });
    const partition = [0b110, 0b01];

    try {
      await predictionMarketSystem.splitPosition(
        collateralToken.address,
        '0x0000000000000000000000000000000000000000000000000000000000000000',
        globalConditionId,
        partition,
        50,
        { from: trader }
      );
    } catch (e) {
      console.log('message:', e.message);
    }

    const collectionIds = partition.map(indexSet =>
      soliditySha3({ type: 'bytes32', value: globalConditionId }, { type: 'uint', value: indexSet })
    );

    const positionIds = collectionIds.map(collectionId =>
      soliditySha3(
        { type: 'address', value: collateralToken.address },
        { type: 'bytes32', value: collectionId }
      )
    );
    await waitForGraphSync();

    for (const [positionId, collectionId] of positionIds.map((p, i) => [p, collectionIds[i]])) {
      assert.equal(await predictionMarketSystem.balanceOf(trader, positionId), 50);
      const userPositionId = (trader + positionId.slice(2)).toLowerCase();
      let positionGraphData = (await axios.post(
        `http://127.0.0.1:8000/subgraphs/name/Gnosis/GnosisMarkets`,
        {
          query: `{userPositions(where: {id: "${userPositionId}"}) {balance position { id } user { id }}}`
        }
      )).data.data.userPositions[0];
      assert.equal(positionGraphData.balance, 50);
      assert.equal(positionGraphData.position.id, positionId);
      assert.equal(positionGraphData.user.id, trader.toLowerCase());
    }

    // split a position from another collectionId --> make sure split adds the all the new UserPosition balances AND subtracts from the former UserPosition
    const collectionToSplitOn = collectionIds[0];
    try {
      await predictionMarketSystem.splitPosition(
        collateralToken.address,
        collectionToSplitOn,
        globalConditionId2,
        partition,
        25,
        { from: trader }
      );
      await waitForGraphSync();
    } catch (e) {
      console.log('message: ', e.message);
    }

    const collectionIds2 = partition.map(
      indexSet =>
        '0x' +
        toHex(
          toBN(collectionToSplitOn).add(
            toBN(keccak256(globalConditionId2 + padLeft(toHex(indexSet), 64).slice(2)))
          )
        ).slice(-64)
    );

    const positionIds2 = collectionIds2.map(collectionId =>
      soliditySha3(
        { type: 'address', value: collateralToken.address },
        { type: 'bytes32', value: collectionId }
      )
    );

    for (const positionId of positionIds2) {
      assert.equal(await predictionMarketSystem.balanceOf(trader, positionId), 25);
      const userPositionId = (trader + positionId.slice(2)).toLowerCase();
      let positionGraphData = (await axios.post(
        `http://127.0.0.1:8000/subgraphs/name/Gnosis/GnosisMarkets`,
        {
          query: `{userPositions(where: {id: "${userPositionId}"}) {balance position { id } user { id }}}`
        }
      )).data.data.userPositions[0];
      assert.equal(positionGraphData.balance, 25);
      assert.equal(positionGraphData.position.id, positionId);
      assert.equal(positionGraphData.user.id, trader.toLowerCase());
    }

    // // verify that parentPosition is -25
    const parentPositionFromSplit = soliditySha3(
      { type: 'address', value: collateralToken.address },
      { type: 'bytes32', value: collectionToSplitOn }
    );
    assert.equal(await predictionMarketSystem.balanceOf(trader, parentPositionFromSplit), 25);
    const parentPositionFromSplitUserPosition = (
      trader + parentPositionFromSplit.slice(2)
    ).toLowerCase();
    let splitPositionGraphData = (await axios.post(
      `http://127.0.0.1:8000/subgraphs/name/Gnosis/GnosisMarkets`,
      {
        query: `{userPositions(where: {id: "${parentPositionFromSplitUserPosition}"}) {balance position { id } user { id }}}`
      }
    )).data.data.userPositions[0];
    assert.equal(splitPositionGraphData.balance, 25);

    // split a position from a different position on the same condition --> make sure split subtracts correctly from the parentIndex and adds to the appropriate list of new indexes, make sure split doesn't add to the full index set

    // split 6 into 4 and 2
    const partition2 = [0b100, 0b10];
    const sixPositionId = positionIds[0];

    try {
      await predictionMarketSystem.splitPosition(
        collateralToken.address,
        '0x00',
        globalConditionId,
        partition2,
        5,
        { from: trader }
      );
      await waitForGraphSync();
    } catch (e) {
      console.log('message: ', e.message);
    }

    assert.equal(await predictionMarketSystem.balanceOf(trader, sixPositionId), 20);

    const collectionIds3 = partition2.map(indexSet => {
      return toHex(
        toBN(
          soliditySha3(
            { type: 'bytes32', value: globalConditionId },
            { type: 'uint', value: indexSet }
          )
        )
      );
    });

    const positionIds3 = collectionIds3.map(collectionId => {
      return soliditySha3(
        { type: 'address', value: collateralToken.address },
        { type: 'bytes32', value: collectionId }
      );
    });

    for (const positionId of positionIds3) {
      assert.equal(await predictionMarketSystem.balanceOf(trader, positionId), 5);
      const userPositionId = (trader + positionId.slice(2)).toLowerCase();
      let positionGraphData = (await axios.post(
        `http://127.0.0.1:8000/subgraphs/name/Gnosis/GnosisMarkets`,
        {
          query: `{userPositions(where: {id: "${userPositionId}"}) {balance position { id } user { id }}}`
        }
      )).data.data.userPositions[0];
      assert.equal(positionGraphData.balance, 5);
      assert.equal(positionGraphData.position.id, positionId);
      assert.equal(positionGraphData.user.id, trader.toLowerCase());
    }
    const sixUserPositionId = (trader + sixPositionId.slice(2)).toLowerCase();
    let positionGraphData = (await axios.post(
      `http://127.0.0.1:8000/subgraphs/name/Gnosis/GnosisMarkets`,
      {
        query: `{userPositions(where: {id: "${sixUserPositionId}"}) {balance position { id } user { id }}}`
      }
    )).data.data.userPositions[0];
    assert.equal(positionGraphData.balance, 20);

    // TESTS FOR TRADING POSITIONS
    await predictionMarketSystem.safeTransferFrom(trader, trader2, sixPositionId, 10, '0x00', {
      from: trader
    });
    await waitForGraphSync();

    assert.equal(await predictionMarketSystem.balanceOf(trader2, sixPositionId), 10);

    // assert that a new UserPosition and User have been created for trader2
    const trader2UserPositionId = (trader2 + sixPositionId.slice(2)).toLowerCase();
    let trader2UserPositionData = (await axios.post(
      `http://127.0.0.1:8000/subgraphs/name/Gnosis/GnosisMarkets`,
      {
        query: `{userPositions(where: {id: "${trader2UserPositionId}"}) {balance position { id } user { id }}}`
      }
    )).data.data.userPositions[0];
    assert.equal(await predictionMarketSystem.balanceOf(trader2, sixPositionId), 10);
    assert.equal(await predictionMarketSystem.balanceOf(trader, sixPositionId), 10);
    assert.equal(trader2UserPositionData.position.id.toLowerCase(), sixPositionId);
    assert.equal(trader2UserPositionData.balance, 10);
    assert.equal(trader2UserPositionData.user.id, trader2.toLowerCase());

    // // TESTS FOR BATCH TRADING OF DIFFERENT OUTCOME TOKENS
    const positionIds4 = positionIds2.slice();
    await predictionMarketSystem.safeBatchTransferFrom(
      trader,
      trader2,
      positionIds4,
      Array.from({ length: positionIds4.length }, () => 5),
      '0x00',
      { from: trader }
    );
    await waitForGraphSync();

    for (const [positionId, collectionId] of positionIds4.map((position, i) => [
      position,
      collectionIds2[i]
    ])) {
      const userPositionId = (trader2 + positionId.slice(2)).toLowerCase();
      let batchTransferUserPositionsData = (await axios.post(
        `http://127.0.0.1:8000/subgraphs/name/Gnosis/GnosisMarkets`,
        {
          query: `{userPositions(where: {id: "${userPositionId}"}) {balance position { id } user { id }}}`
        }
      )).data.data.userPositions[0];
      assert.equal(await predictionMarketSystem.balanceOf(trader2, positionId), 5);
      assert.equal(await predictionMarketSystem.balanceOf(trader, positionId), 20);
      assert.equal(batchTransferUserPositionsData.balance, 5);
      assert.equal(batchTransferUserPositionsData.position.id.toLowerCase(), positionId);
      assert.equal(batchTransferUserPositionsData.user.id, trader2.toLowerCase());
    }
  });
});
