const assert = require('assert');
const axios = require('axios');
const delay = require('delay');
const TruffleContract = require('truffle-contract');
const PredictionMarketSystem = TruffleContract(
  require('@gnosis.pm/hg-contracts/build/contracts/PredictionMarketSystem.json')
);
const ERC20Mintable = TruffleContract(
  require('openzeppelin-solidity/build/contracts/ERC20Mintable.json')
);
[PredictionMarketSystem, ERC20Mintable].forEach(C => C.setProvider('http://localhost:8545'));
const web3 = PredictionMarketSystem.web3;
const { randomHex, soliditySha3, toHex, toBN, padLeft, keccak256 } = web3.utils;

async function waitForGraphSync(targetBlockNumber) {
  if (targetBlockNumber == null) targetBlockNumber = await web3.eth.getBlockNumber();

  do {
    await delay(100);
  } while (
    (await axios.post('http://127.0.0.1:8000/subgraphs', {
      query:
        '{subgraphVersions(orderBy:createdAt orderDirection:desc first:1){deployment{latestEthereumBlockNumber}}}'
    })).data.data.subgraphVersions[0].deployment.latestEthereumBlockNumber < targetBlockNumber
  );
}

describe('hg-subgraph conditions <> collections <> positions', function() {
  this.timeout(5000);
  let accounts, predictionMarketSystem, collateralToken, minter;

  before(async function() {
    this.timeout(30000);
    accounts = await web3.eth.getAccounts();
    web3.eth.defaultAccount = minter = accounts[0];
    predictionMarketSystem = await PredictionMarketSystem.deployed();
    collateralToken = await ERC20Mintable.new({ from: minter });
    await waitForGraphSync();
  });

  it('matches the configuration', async () => {
    assert.equal(predictionMarketSystem.address, '0xCfEB869F69431e42cdB54A4F4f105C19C080A601');
  });

  it('allows GraphQL queries', async () => {
    assert(
      (await axios.post('http://127.0.0.1:8000/subgraphs/name/Gnosis/GnosisMarkets', {
        operationName: null,
        query: '{conditions(first:1){id}}',
        variables: null
      })).data.data.conditions
    );
  });

  it('will index conditions upon preparation and update them upon resolution', async () => {
    const [creator, oracle] = accounts;
    const questionId = randomHex(32);
    const outcomeSlotCount = 3;
    const conditionId = soliditySha3(
      { type: 'address', value: oracle },
      { type: 'bytes32', value: questionId },
      { type: 'uint', value: outcomeSlotCount }
    );

    const {
      tx: createTransaction,
      receipt: { blockNumber: createBlockNumber }
    } = await predictionMarketSystem.prepareCondition(oracle, questionId, outcomeSlotCount, {
      from: creator
    });

    const { timestamp: creationTimestamp } = await web3.eth.getBlock(createBlockNumber);

    await waitForGraphSync();

    const conditionQuery = `{
      condition(id:"${conditionId}") {
        id
        creator
        oracle
        questionId
        outcomeSlotCount
        resolved
        payoutNumerators
        payoutDenominator
        createTransaction
        creationTimestamp
        resolveTransaction
        resolveTimestamp
        blockNumber
        collections
      }
    }`;

    let { condition } = (await axios.post(
      'http://127.0.0.1:8000/subgraphs/name/Gnosis/GnosisMarkets',
      { query: conditionQuery }
    )).data.data;

    assert.deepEqual(condition, {
      id: conditionId,
      creator: creator.toLowerCase(),
      oracle: oracle.toLowerCase(),
      questionId,
      outcomeSlotCount,
      resolved: false,
      payoutNumerators: null,
      payoutDenominator: null,
      createTransaction,
      creationTimestamp: creationTimestamp.toString(),
      resolveTransaction: null,
      resolveTimestamp: null,
      blockNumber: createBlockNumber.toString(),
      collections: []
    });

    const payoutNumerators = [0, 1, 0];
    const {
      tx: resolveTransaction,
      receipt: { blockNumber: resolveBlockNumber }
    } = await predictionMarketSystem.receiveResult(
      questionId,
      web3.eth.abi.encodeParameters(new Array(outcomeSlotCount).fill('uint256'), payoutNumerators),
      { from: oracle }
    );
    const { timestamp: resolutionTimestamp } = await web3.eth.getBlock(resolveBlockNumber);

    await waitForGraphSync();

    condition = (await axios.post('http://127.0.0.1:8000/subgraphs/name/Gnosis/GnosisMarkets', {
      query: conditionQuery
    })).data.data.condition;

    assert.deepEqual(condition, {
      id: conditionId,
      creator: creator.toLowerCase(),
      oracle: oracle.toLowerCase(),
      questionId,
      outcomeSlotCount,
      resolved: true,
      payoutNumerators: payoutNumerators.map(x => x.toString()),
      payoutDenominator: payoutNumerators.reduce((a, b) => a + b, 0).toString(),
      createTransaction,
      creationTimestamp: creationTimestamp.toString(),
      resolveTransaction: resolveTransaction,
      resolveTimestamp: resolutionTimestamp.toString(),
      blockNumber: createBlockNumber.toString(),
      collections: []
    });
  });

  it('will collect info from splitting and merging positions', async () => {
    const [creator, oracle, trader] = accounts;
    const conditionsInfo = Array.from({ length: 2 }, () => {
      const questionId = randomHex(32);
      const outcomeSlotCount = 68;
      const conditionId = soliditySha3(
        { type: 'address', value: oracle },
        { type: 'bytes32', value: questionId },
        { type: 'uint', value: outcomeSlotCount }
      );
      return { questionId, outcomeSlotCount, conditionId };
    });

    await Promise.all(
      conditionsInfo.map(({ questionId, outcomeSlotCount }) =>
        predictionMarketSystem.prepareCondition(oracle, questionId, outcomeSlotCount, {
          from: creator
        })
      )
    );

    await collateralToken.mint(trader, 100, { from: minter });
    assert.equal(await collateralToken.balanceOf(trader), 100);

    await collateralToken.approve(predictionMarketSystem.address, 100, { from: trader });
    const partition = ['0xffffffff000000000', '0x00000000fffffffff'];
    await predictionMarketSystem.splitPosition(
      collateralToken.address,
      '0x0000000000000000000000000000000000000000000000000000000000000000',
      conditionsInfo[0].conditionId,
      partition,
      100,
      { from: trader }
    );

    const collectionIds = partition.map(indexSet =>
      keccak256(conditionsInfo[0].conditionId + padLeft(toHex(indexSet), 64).slice(2))
    );

    const positionIds = collectionIds.map(collectionId =>
      keccak256(collateralToken.address + collectionId.slice(2))
    );

    for (const positionId of positionIds) {
      assert.equal(await predictionMarketSystem.balanceOf(trader, positionId), 100);
    }

    assert.equal(await collateralToken.balanceOf(trader), 0);

    await waitForGraphSync();

    for (const [collectionId, indexSet] of collectionIds.map((c, i) => [c, partition[i]])) {
      const { collection } = (await axios.post(
        'http://127.0.0.1:8000/subgraphs/name/Gnosis/GnosisMarkets',
        {
          query: `{
                    collection(id: "${collectionId}") {
                        id
                        conditions { id }
                        indexSets
                    }
                }`
        }
      )).data.data;
      assert(collection, `collection ${collectionId} not found`);
      assert.equal(collection.conditions.length, collection.indexSets.length);
      assert.equal(collection.conditions.length, 1);
      assert.equal(collection.conditions[0].id, conditionsInfo[0].conditionId);
      assert.equal(collection.indexSets[0], toBN(indexSet).toString());
    }

    for (const [positionId, collectionId] of positionIds.map((p, i) => [p, collectionIds[i]])) {
      assert.equal(await predictionMarketSystem.balanceOf(trader, positionId), 100);
      const { position } = (await axios.post(
        'http://127.0.0.1:8000/subgraphs/name/Gnosis/GnosisMarkets',
        {
          query: `{
                    position(id: "${positionId}") {
                        id
                        collateralToken
                        collection { id }
                    }
                }`
        }
      )).data.data;

      assert(position, `position ${positionId} not found`);
      assert.equal(position.collection.id, collectionId);
    }

    const parentCollectionId2 = collectionIds[0];
    const parentCollectionId2BN = toBN(parentCollectionId2);
    await predictionMarketSystem.splitPosition(
      collateralToken.address,
      parentCollectionId2,
      conditionsInfo[1].conditionId,
      partition,
      100,
      { from: trader }
    );

    const collectionIds2 = partition.map(indexSet =>
      padLeft(
        toHex(
          toBN(
            soliditySha3(
              { type: 'bytes32', value: conditionsInfo[1].conditionId },
              { type: 'uint', value: indexSet }
            )
          )
            .add(parentCollectionId2BN)
            .maskn(256)
        ),
        64
      )
    );

    const positionIds2 = collectionIds2.map(collectionId =>
      keccak256(collateralToken.address + collectionId.slice(2))
    );

    await waitForGraphSync();

    for (const collectionId of collectionIds2) {
      const { collection } = (await axios.post(
        'http://127.0.0.1:8000/subgraphs/name/Gnosis/GnosisMarkets',
        {
          query: `{
            collection(id: "${collectionId}") {
              id
              conditions { id }
              indexSets
            }
          }`
        }
      )).data.data;
      assert(collection, `collection ${collectionId} not found`);
      assert.equal(collection.conditions.length, collection.indexSets.length);
      assert.equal(collection.conditions.length, 2);
      const parentIndex = collection.conditions.findIndex(
        ({ id }) => id === conditionsInfo[0].conditionId
      );
      assert.notEqual(parentIndex, -1);
      // assert.equal(collection.indexSets[parentIndex], toBN(partition[0]).toString())
      const cIndex = collection.conditions.findIndex(
        ({ id }) => id === conditionsInfo[1].conditionId
      );
      assert.notEqual(cIndex, -1);
      // assert.equal(collection.indexSets[cIndex], toBN(indexSet).toString())
    }

    for (const [positionId, collectionId] of positionIds2.map((p, i) => [p, collectionIds2[i]])) {
      assert.equal(await predictionMarketSystem.balanceOf(trader, positionId), 100);
      const { position } = (await axios.post(
        'http://127.0.0.1:8000/subgraphs/name/Gnosis/GnosisMarkets',
        {
          query: `{
                    position(id: "${positionId}") {
                        id
                        collateralToken
                        collection { id }
                    }
                }`
        }
      )).data.data;

      assert(position, `position ${positionId} not found`);
      assert.equal(position.collateralToken, collateralToken.address.toLowerCase());
      assert.equal(position.collection.id, collectionId);
    }
  });
});
