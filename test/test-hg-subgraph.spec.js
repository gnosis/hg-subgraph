const { assert } = require('chai');
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

async function querySubgraph(query) {
  const response = await axios.post('http://127.0.0.1:8000/subgraphs/name/Gnosis/GnosisMarkets', {
    query
  });
  return response.data.data;
}

async function getCondition(conditionId) {
  return (await querySubgraph(`{
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
      collections { id }
    }
  }`)).condition;
}

async function getCollection(collectionId) {
  return (await querySubgraph(`{
    collection(id: "${collectionId}") {
      id
      conditions { id }
      indexSets
    }
  }`)).collection;
}

async function getPosition(positionId) {
  return (await querySubgraph(`{
    position(id: "${positionId}") {
      id
      collateralToken
      collection { id }
      conditions { id }
      indexSets
      lifetimeValue
      activeValue
    }
  }`)).position;
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
    assert(await querySubgraph('{conditions(first:1){id}}'));
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

    let condition = await getCondition(conditionId);

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

    condition = await getCondition(conditionId);

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

    // normal complete split
    // =====================

    const partition1 = ['0xffffffff000000000', '0x00000000fffffffff'].map(indexSet =>
      toBN(indexSet)
    );
    await predictionMarketSystem.splitPosition(
      collateralToken.address,
      `0x${'00'.repeat(32)}`,
      conditionsInfo[0].conditionId,
      partition1,
      100,
      { from: trader }
    );

    const collectionIds = partition1.map(indexSet =>
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

    for (const [collectionId, indexSet] of collectionIds.map((c, i) => [c, partition1[i]])) {
      const collection = await getCollection(collectionId);
      assert.deepEqual(collection, {
        id: collectionId,
        conditions: [{ id: conditionsInfo[0].conditionId }],
        indexSets: [indexSet.toString()]
      });
    }

    for (const [positionId, indexSet, collectionId] of positionIds.map((p, i) => [
      p,
      partition1[i],
      collectionIds[i]
    ])) {
      assert.equal(await predictionMarketSystem.balanceOf(trader, positionId), 100);
      const position = await getPosition(positionId);

      assert.deepEqual(position, {
        id: positionId,
        collateralToken: collateralToken.address.toLowerCase(),
        collection: {
          id: collectionId
        },
        conditions: [{ id: conditionsInfo[0].conditionId }],
        indexSets: [indexSet.toString()],
        lifetimeValue: '100',
        activeValue: '100'
      });
    }

    // deep complete splits
    // ====================

    const partition2 = ['0xf0f0f0f0f0f0f0f0f', '0x0f0f0f0f0f0f0f0f0'].map(indexSet =>
      toBN(indexSet)
    );

    for (const [parentPositionId, parentCollectionId, parentIndexSet] of positionIds.map(
      (positionId, i) => [positionId, collectionIds[i], partition1[i]]
    )) {
      await predictionMarketSystem.splitPosition(
        collateralToken.address,
        parentCollectionId,
        conditionsInfo[1].conditionId,
        partition2,
        100,
        { from: trader }
      );

      const parentCollectionIdBN = toBN(parentCollectionId);
      const collectionIds2 = partition2.map(indexSet =>
        padLeft(
          toHex(
            toBN(
              soliditySha3(
                { type: 'bytes32', value: conditionsInfo[1].conditionId },
                { type: 'uint', value: indexSet }
              )
            )
              .add(parentCollectionIdBN)
              .maskn(256)
          ),
          64
        )
      );

      const positionIds2 = collectionIds2.map(collectionId =>
        keccak256(collateralToken.address + collectionId.slice(2))
      );

      await waitForGraphSync();

      const parentPosition = await getPosition(parentPositionId);
      assert.deepEqual(parentPosition, {
        id: parentPositionId,
        collateralToken: collateralToken.address.toLowerCase(),
        collection: {
          id: parentCollectionId
        },
        conditions: [{ id: conditionsInfo[0].conditionId }],
        indexSets: [parentIndexSet.toString()],
        lifetimeValue: '100',
        activeValue: '0'
      });

      for (const [collectionId, indexSet] of collectionIds2.map((collectionId, i) => [
        collectionId,
        partition2[i]
      ])) {
        const collection = await getCollection(collectionId);
        assert(collection, `collection ${collectionId} not found`);
        assert.equal(collection.conditions.length, 2);
        assert.equal(collection.indexSets.length, 2);
        assert.sameDeepMembers(
          collection.conditions.map((condition, i) => ({
            conditionId: condition.id,
            indexSet: collection.indexSets[i]
          })),
          [
            {
              conditionId: conditionsInfo[0].conditionId,
              indexSet: parentIndexSet.toString()
            },
            {
              conditionId: conditionsInfo[1].conditionId,
              indexSet: indexSet.toString()
            }
          ]
        );
      }

      for (const [positionId, collectionId, indexSet] of positionIds2.map((positionId, i) => [
        positionId,
        collectionIds2[i],
        partition2[i]
      ])) {
        assert.equal(await predictionMarketSystem.balanceOf(trader, positionId), 100);
        const position = await getPosition(positionId);

        assert.deepInclude(position, {
          id: positionId,
          collateralToken: collateralToken.address.toLowerCase(),
          collection: {
            id: collectionId
          },
          lifetimeValue: '100',
          activeValue: '100'
        });

        assert.equal(position.conditions.length, position.indexSets.length);
        assert.sameDeepMembers(
          position.conditions.map((condition, i) => ({
            conditionId: condition.id,
            indexSet: position.indexSets[i]
          })),
          [
            {
              conditionId: conditionsInfo[0].conditionId,
              indexSet: parentIndexSet.toString()
            },
            {
              conditionId: conditionsInfo[1].conditionId,
              indexSet: indexSet.toString()
            }
          ]
        );
      }
    }

    // deep partial splits
    // ===================

    const partition3 = ['0xaaaaaaaa000000000', '0x55555555000000000'].map(indexSet =>
      toBN(indexSet)
    );
    const partition3Union = partition3.reduce((a, b) => a.add(b));
    assert(partition3Union.eq(partition1[0]));

    const collectionIds2 = partition2.map(indexSet =>
      keccak256(conditionsInfo[1].conditionId + padLeft(toHex(indexSet), 64).slice(2))
    );

    for (const [parentCollectionId, parentIndexSet] of collectionIds2.map((collectionId, i) => [
      collectionId,
      partition2[i]
    ])) {
      const parentCollectionIdBN = toBN(parentCollectionId);
      const unionCollectionId = padLeft(
        toHex(
          toBN(
            soliditySha3(
              { type: 'bytes32', value: conditionsInfo[0].conditionId },
              { type: 'uint', value: partition3Union }
            )
          )
            .add(parentCollectionIdBN)
            .maskn(256)
        ),
        64
      );
      const parentPositionId = keccak256(collateralToken.address + unionCollectionId.slice(2));

      assert.equal(await predictionMarketSystem.balanceOf(trader, parentPositionId), 100);

      await predictionMarketSystem.splitPosition(
        collateralToken.address,
        parentCollectionId,
        conditionsInfo[0].conditionId,
        partition3,
        100,
        { from: trader }
      );

      assert.equal(await predictionMarketSystem.balanceOf(trader, parentPositionId), 0);

      await waitForGraphSync();

      const parentPosition = await getPosition(parentPositionId);
      assert.deepInclude(parentPosition, {
        id: parentPositionId,
        collateralToken: collateralToken.address.toLowerCase(),
        collection: {
          id: unionCollectionId
        },
        lifetimeValue: '100',
        activeValue: '0'
      });
      assert.equal(parentPosition.conditions.length, 2);
      assert.equal(parentPosition.indexSets.length, 2);
      assert.sameDeepMembers(
        parentPosition.conditions.map((condition, i) => ({
          conditionId: condition.id,
          indexSet: parentPosition.indexSets[i]
        })),
        [
          {
            conditionId: conditionsInfo[0].conditionId,
            indexSet: partition3Union.toString()
          },
          {
            conditionId: conditionsInfo[1].conditionId,
            indexSet: parentIndexSet.toString()
          }
        ]
      );

      const collectionIds3 = partition3.map(indexSet =>
        padLeft(
          toHex(
            toBN(
              soliditySha3(
                { type: 'bytes32', value: conditionsInfo[0].conditionId },
                { type: 'uint', value: indexSet }
              )
            )
              .add(parentCollectionIdBN)
              .maskn(256)
          ),
          64
        )
      );

      const positionIds3 = collectionIds3.map(collectionId =>
        keccak256(collateralToken.address + collectionId.slice(2))
      );

      for (const [collectionId, indexSet] of collectionIds3.map((collectionId, i) => [
        collectionId,
        partition3[i]
      ])) {
        const collection = await getCollection(collectionId);
        assert(collection, `collection ${collectionId} not found`);
        assert.equal(collection.conditions.length, 2);
        assert.equal(collection.indexSets.length, 2);
        assert.sameDeepMembers(
          collection.conditions.map((condition, i) => ({
            conditionId: condition.id,
            indexSet: collection.indexSets[i]
          })),
          [
            {
              conditionId: conditionsInfo[0].conditionId,
              indexSet: indexSet.toString()
            },
            {
              conditionId: conditionsInfo[1].conditionId,
              indexSet: parentIndexSet.toString()
            }
          ]
        );
      }

      for (const [positionId, collectionId, indexSet] of positionIds3.map((positionId, i) => [
        positionId,
        collectionIds3[i],
        partition3[i]
      ])) {
        assert.equal(await predictionMarketSystem.balanceOf(trader, positionId), 100);
        const position = await getPosition(positionId);

        assert.deepInclude(position, {
          id: positionId,
          collateralToken: collateralToken.address.toLowerCase(),
          collection: {
            id: collectionId
          },
          lifetimeValue: '100',
          activeValue: '100'
        });

        assert.equal(position.conditions.length, position.indexSets.length);
        assert.sameDeepMembers(
          position.conditions.map((condition, i) => ({
            conditionId: condition.id,
            indexSet: position.indexSets[i]
          })),
          [
            {
              conditionId: conditionsInfo[0].conditionId,
              indexSet: indexSet.toString()
            },
            {
              conditionId: conditionsInfo[1].conditionId,
              indexSet: parentIndexSet.toString()
            }
          ]
        );
      }
    }
  });
});
