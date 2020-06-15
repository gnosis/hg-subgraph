const { assert } = require('chai');
const { gql } = require('apollo-boost');

const TruffleContract = require('@truffle/contract');

const ConditionalTokens = TruffleContract(
  require('@gnosis.pm/conditional-tokens-contracts/build/contracts/ConditionalTokens.json')
);
const ERC20Mintable = TruffleContract(
  require('openzeppelin-solidity/build/contracts/ERC20Mintable.json')
);
[ConditionalTokens, ERC20Mintable].forEach((C) => C.setProvider('http://localhost:8545'));

const web3 = ConditionalTokens.web3;

const { randomHex } = web3.utils;
const {
  getConditionId,
  getCollectionId,
  getPositionId,
  combineCollectionIds,
} = require('@gnosis.pm/conditional-tokens-contracts/utils/id-helpers')(web3.utils);

const { waitForGraphSync, subgraphClient } = require('./utils')({ web3 });

function toUserPositionId(userAddress, positionId) {
  return (userAddress + positionId.replace(/^0x/, '')).toLowerCase();
}

const collateralTokenQuery = gql`
  query($collateralId: ID) {
    collateralToken(id: $collateralId) {
      id
      activeAmount
      splitAmount
      mergedAmount
      redeemedAmount
    }
  }
`;

const userQuery = gql`
  query($userId: ID) {
    user(id: $userId) {
      id
      userPositions {
        id
      }
      firstParticipation
      lastActive
    }
  }
`;

const positionAndUserPositionQuery = gql`
  query($positionId: ID, $userPositionId: ID) {
    position(id: $positionId) {
      id
      collateralToken {
        id
      }
      collection {
        id
      }
      conditions {
        id
      }
      indexSets
      lifetimeValue
      activeValue
    }

    userPosition(id: $userPositionId) {
      id
      balance
      position {
        id
      }
      user {
        id
      }
    }
  }
`;

const rootCollectionId = '0x0000000000000000000000000000000000000000000000000000000000000000';

describe('Complete scenario tests for accurate mappings', function () {
  this.timeout(20000);

  let accounts, minter, trader1, trader2, creator, oracle;
  step('get accounts', async function () {
    accounts = await web3.eth.getAccounts();
    [trader1, trader2] = accounts;
    web3.eth.defaultAccount = minter = accounts[0];
    [creator, oracle] = accounts;
  });

  let conditionalTokens, collateralToken;
  step('get required contracts', async function () {
    conditionalTokens = await ConditionalTokens.deployed();
    collateralToken = await ERC20Mintable.new({ from: minter });
  });

  step('wait for graph sync', async () => {
    await waitForGraphSync();
  });

  let trader1StartingNumPositions = 0;
  let trader2StartingNumPositions = 0;
  step('get starting vars of traders off of graph', async function () {
    const { user: user1 } = (
      await subgraphClient.query({
        query: userQuery,
        variables: { userId: trader1.toLowerCase() },
      })
    ).data;

    if (user1 != null) {
      trader1StartingNumPositions = user1.userPositions.length;
    }

    const { user: user2 } = (
      await subgraphClient.query({
        query: userQuery,
        variables: { userId: trader2.toLowerCase() },
      })
    ).data;

    if (user2 != null) {
      trader2StartingNumPositions = user2.userPositions.length;
    }
  });

  let conditionsInfo, conditionId1, conditionId2;
  step('prepare conditions', async function () {
    conditionsInfo = Array.from({ length: 2 }, () => {
      const questionId = randomHex(32);
      const payouts = [0, 1, 0];
      const outcomeSlotCount = payouts.length;
      const id = getConditionId(oracle, questionId, outcomeSlotCount);
      return { questionId, outcomeSlotCount, id, payouts };
    });

    for (const { questionId, outcomeSlotCount } of conditionsInfo) {
      await conditionalTokens.prepareCondition(oracle, questionId, outcomeSlotCount, {
        from: creator,
      });
    }

    conditionId1 = conditionsInfo[0].id;
    conditionId2 = conditionsInfo[1].id;
  });

  step('mint T1 $100', async function () {
    await collateralToken.mint(trader1, 100, { from: minter });
    assert.equal(await collateralToken.balanceOf(trader1), 100);
  });

  const partition = [0b110, 0b01];
  let collectionIds1, positionIds1;
  step('T1 split $50 -C1-> [$50:C1(b|c), $50:C1(a)]', async () => {
    await collateralToken.approve(conditionalTokens.address, 100, { from: trader1 });

    await conditionalTokens.splitPosition(
      collateralToken.address,
      rootCollectionId,
      conditionId1,
      partition,
      50,
      { from: trader1 }
    );

    collectionIds1 = partition.map((indexSet) => getCollectionId(conditionId1, indexSet));
    positionIds1 = collectionIds1.map((collectionId) =>
      getPositionId(collateralToken.address, collectionId)
    );
  });

  step('wait for graph sync', async () => {
    await waitForGraphSync();
  });

  step('check graph collateral data', async () => {
    const { collateralToken: collateralTokenData } = (
      await subgraphClient.query({
        query: collateralTokenQuery,
        variables: {
          collateralId: collateralToken.address.toLowerCase(),
        },
      })
    ).data;
    assert.equal(collateralTokenData.activeAmount, 50);
    assert.equal(collateralTokenData.splitAmount, 50);
    assert.equal(collateralTokenData.mergedAmount, 0);
    assert.equal(collateralTokenData.redeemedAmount, 0);
  });

  step('check graph T1 C1 positions data', async () => {
    for (const [positionId, collectionId] of positionIds1.map((p, i) => [p, collectionIds1[i]])) {
      assert.equal(await conditionalTokens.balanceOf(trader1, positionId), 50);
      const userPositionId = toUserPositionId(trader1, positionId);
      const { position, userPosition } = (
        await subgraphClient.query({
          query: positionAndUserPositionQuery,
          variables: { positionId, userPositionId },
        })
      ).data;
      assert(position, "Positions weren't created in The Graph");
      assert.equal(position.activeValue, 50);
      assert.equal(position.lifetimeValue, 50);
      assert.equal(position.collection.id, collectionId);
      assert.include(partition, parseInt(position.indexSets[0]));
      assert.lengthOf(position.indexSets, 1);
      assert.lengthOf(position.conditions, 1);
      assert.equal(position.collateralToken.id, collateralToken.address.toLowerCase());

      assert.equal(userPosition.balance, 50);
      assert.equal(userPosition.position.id, positionId);
      assert.equal(userPosition.user.id, trader1.toLowerCase());
    }

    const { user } = (
      await subgraphClient.query({
        query: userQuery,
        variables: { userId: trader1.toLowerCase() },
      })
    ).data;

    assert.lengthOf(user.userPositions, trader1StartingNumPositions + 2);
    assert.includeMembers(
      user.userPositions.map((userPosition) => '0x' + userPosition.id.slice(42)),
      positionIds1
    );
  });

  let collectionToSplitOn, collectionNotSplitOn;
  let collectionIds2, positionIds2;
  step('T1 split $25:C1(b|c) -C2-> [$25:C1(b|c)&C2(b|c), $50:C1(b|c)&C2(a)]', async () => {
    collectionToSplitOn = collectionIds1[0];
    collectionNotSplitOn = collectionIds1[1];

    await conditionalTokens.splitPosition(
      collateralToken.address,
      collectionToSplitOn,
      conditionId2,
      partition,
      25,
      { from: trader1 }
    );

    collectionIds2 = partition.map((indexSet) =>
      combineCollectionIds([collectionToSplitOn, getCollectionId(conditionId2, indexSet)])
    );

    positionIds2 = collectionIds2.map((collectionId) =>
      getPositionId(collateralToken.address, collectionId)
    );
  });

  step('wait for graph sync', async () => {
    await waitForGraphSync();
  });

  step('check graph T1 user data', async () => {
    let user = (
      await subgraphClient.query({
        query: userQuery,
        variables: { userId: trader1.toLowerCase() },
      })
    ).data.user;
    assert.lengthOf(user.userPositions, trader1StartingNumPositions + 4);
    assert.includeMembers(
      user.userPositions.map((userPosition) => '0x' + userPosition.id.slice(42)),
      [...positionIds1, ...positionIds2]
    );
  });

  step('check graph T1 C1(b|c) data changed', async () => {
    const parentPositionFromSplit = getPositionId(collateralToken.address, collectionToSplitOn);
    assert.equal(await conditionalTokens.balanceOf(trader1, parentPositionFromSplit), 25);
    const parentPositionFromSplitUserPosition = toUserPositionId(
      trader1,
      parentPositionFromSplit.slice(2)
    );
    const { position, userPosition } = (
      await subgraphClient.query({
        query: positionAndUserPositionQuery,
        variables: {
          positionId: parentPositionFromSplit,
          userPositionId: parentPositionFromSplitUserPosition,
        },
      })
    ).data;
    assert.equal(position.lifetimeValue, 50);
    assert.equal(position.activeValue, 25);
    assert.equal(userPosition.balance, 25);
    assert.include(positionIds1, userPosition.position.id);
    assert.equal(userPosition.user.id, trader1.toLowerCase());
  });

  step('check graph T1 C1(a) data has not changed', async () => {
    const notSplitPosition = getPositionId(collateralToken.address, collectionNotSplitOn);
    const usernotSplitPosition = toUserPositionId(trader1, notSplitPosition);
    assert.equal(await conditionalTokens.balanceOf(trader1, notSplitPosition), 50);
    let { position, userPosition } = (
      await subgraphClient.query({
        query: positionAndUserPositionQuery,
        variables: {
          positionId: notSplitPosition,
          userPositionId: usernotSplitPosition,
        },
      })
    ).data;
    assert.equal(position.lifetimeValue, 50);
    assert.equal(position.activeValue, 50);
    assert.equal(position.id, notSplitPosition.toLowerCase());
    assert.equal(userPosition.balance, 50);
    assert.equal(userPosition.position.id, notSplitPosition);
  });

  step('check graph T1 C1(b|c)&C2 positions data', async () => {
    for (const [positionId, collectionId] of positionIds2.map((posId, i) => [
      posId,
      collectionIds2[i],
    ])) {
      assert.equal(await conditionalTokens.balanceOf(trader1, positionId), 25);
      const userPositionId = toUserPositionId(trader1, positionId);
      const { position, userPosition } = (
        await subgraphClient.query({
          query: positionAndUserPositionQuery,
          variables: { positionId, userPositionId },
        })
      ).data;

      assert.equal(position.collateralToken.id, collateralToken.address.toLowerCase());
      assert.lengthOf(position.conditions, 2);
      const positionConditionIds = position.conditions.map((condition) => {
        return condition.id;
      });
      assert.sameMembers(positionConditionIds, [conditionId1, conditionId2]);
      assert.equal(position.activeValue, 25);
      assert.equal(position.collection.id, collectionId);
      assert.include(partition, parseInt(position.indexSets));
      assert.lengthOf(position.indexSets, 2);

      assert.equal(userPosition.balance, 25);
      assert.equal(userPosition.position.id, positionId);
      assert.equal(userPosition.user.id, trader1.toLowerCase());
    }
  });

  const partition2 = [0b100, 0b010];
  let collectionIds3, positionIds3;
  step('T1 split $5:C1(b|c) -C1-> [$5:C1(b), $5:C1(c)]', async () => {
    await conditionalTokens.splitPosition(
      collateralToken.address,
      rootCollectionId,
      conditionId1,
      partition2,
      5,
      { from: trader1 }
    );

    assert.equal(await conditionalTokens.balanceOf(trader1, positionIds1[0]), 20);
    assert.equal(await conditionalTokens.balanceOf(trader1, positionIds1[1]), 50);

    collectionIds3 = partition2.map((indexSet) => getCollectionId(conditionId1, indexSet));

    positionIds3 = collectionIds3.map((collectionId) =>
      getPositionId(collateralToken.address, collectionId)
    );
  });

  step('check graph T1 user data', async () => {
    await waitForGraphSync();

    const { user } = (
      await subgraphClient.query({
        query: userQuery,
        variables: { userId: trader1.toLowerCase() },
      })
    ).data;

    assert.lengthOf(user.userPositions, trader1StartingNumPositions + 6);
    assert.includeMembers(
      user.userPositions.map((userPosition) => '0x' + userPosition.id.slice(42)),
      [...positionIds1, ...positionIds2, ...positionIds3]
    );
  });

  step('check graph T1 C1(b), C1(c) position data', async () => {
    for (const [positionId, collectionId] of positionIds3.map((p, i) => [p, collectionIds3[i]])) {
      assert.equal(await conditionalTokens.balanceOf(trader1, positionId), 5);
      const userPositionId = toUserPositionId(trader1, positionId);
      const { position, userPosition } = (
        await subgraphClient.query({
          query: positionAndUserPositionQuery,
          variables: { positionId, userPositionId },
        })
      ).data;

      assert.equal(position.collateralToken.id, collateralToken.address.toLowerCase());
      assert.lengthOf(position.conditions, 1);
      const positionConditionIds = position.conditions.map((condition) => {
        return condition.id;
      });
      assert.sameMembers(positionConditionIds, [conditionId1]);
      assert.equal(position.activeValue, 5);
      assert.equal(position.collection.id, collectionId);
      assert.lengthOf(position.indexSets, 1);

      assert.equal(userPosition.balance, 5);
      assert.equal(userPosition.position.id, positionId);
      assert.equal(userPosition.user.id, trader1.toLowerCase());
    }
  });

  step('check graph T1 C1(b|c) position data', async () => {
    const { position, userPosition } = (
      await subgraphClient.query({
        query: positionAndUserPositionQuery,
        variables: {
          positionId: positionIds1[0],
          userPositionId: toUserPositionId(trader1, positionIds1[0]),
        },
      })
    ).data;
    assert.equal(position.activeValue, 20);
    assert.equal(position.lifetimeValue, 50);
    assert.equal(userPosition.balance, 20);
    assert.lengthOf(position.conditions, 1);
    assert.equal(userPosition.position.id, positionIds1[0]);
  });

  step('T1 merge [$5:C1(b), $5:C1(c)] -C1-> $5:C1(b|c)', async () => {
    await conditionalTokens.mergePositions(
      collateralToken.address,
      rootCollectionId,
      conditionId1,
      partition2,
      5,
      { from: trader1 }
    );
  });

  step('wait for graph sync', async () => {
    await waitForGraphSync();
  });

  step('check graph T1 C1(b), C1(c) positions data', async () => {
    for (const [positionId, collectionId] of positionIds3.map((p, i) => [p, collectionIds3[i]])) {
      assert.equal(await conditionalTokens.balanceOf(trader1, positionId), 0);
      const userPositionId = toUserPositionId(trader1, positionId);
      const { position, userPosition } = (
        await subgraphClient.query({
          query: positionAndUserPositionQuery,
          variables: { positionId, userPositionId },
        })
      ).data;

      assert.equal(position.collateralToken.id, collateralToken.address.toLowerCase());
      assert.lengthOf(position.conditions, 1);
      const positionConditionIds = position.conditions.map((condition) => {
        return condition.id;
      });
      assert.sameMembers(positionConditionIds, [conditionId1]);
      assert.equal(position.activeValue, 0);
      assert.equal(position.lifetimeValue, 5);
      assert.equal(position.collection.id, collectionId);
      assert.lengthOf(position.indexSets, 1);

      assert.equal(userPosition.balance, 0);
      assert.equal(userPosition.position.id, positionId);
      assert.equal(userPosition.user.id, trader1.toLowerCase());
    }
  });

  step('T1 merge [$25:C1(b|c)&C2(b|c), $50:C1(b|c)&C2(a)] -C2-> $25:C1(b|c)', async () => {
    await conditionalTokens.mergePositions(
      collateralToken.address,
      collectionToSplitOn,
      conditionId2,
      partition,
      5,
      { from: trader1 }
    );
  });

  step('wait for graph sync', async () => {
    await waitForGraphSync();
  });

  step('check graph T1 C1(b|c)&C2 positions data', async () => {
    for (const [positionId, collectionId] of positionIds2.map((posId, i) => [
      posId,
      collectionIds2[i],
    ])) {
      assert.equal(await conditionalTokens.balanceOf(trader1, positionId), 20);
      const userPositionId = toUserPositionId(trader1, positionId);
      const { position, userPosition } = (
        await subgraphClient.query({
          query: positionAndUserPositionQuery,
          variables: { positionId, userPositionId },
        })
      ).data;
      assert.equal(position.collateralToken.id, collateralToken.address.toLowerCase());
      assert.lengthOf(position.conditions, 2);
      const positionConditionIds = position.conditions.map((condition) => {
        return condition.id;
      });
      assert.sameMembers(positionConditionIds, [conditionId1, conditionId2]);
      assert.equal(position.activeValue, 20);
      assert.equal(position.lifetimeValue, 25);
      assert.equal(position.collection.id, collectionId);
      assert.include(partition, parseInt(position.indexSets));
      assert.lengthOf(position.indexSets, 2);

      assert.equal(userPosition.balance, 20);
      assert.equal(userPosition.position.id, positionId);
      assert.equal(userPosition.user.id, trader1.toLowerCase());
    }
  });

  step('check graph T1 C1(b|c) position data', async () => {
    const { position, userPosition } = (
      await subgraphClient.query({
        query: positionAndUserPositionQuery,
        variables: {
          positionId: positionIds1[0],
          userPositionId: toUserPositionId(trader1, positionIds1[0]),
        },
      })
    ).data;
    assert.equal(position.activeValue, 30);
    assert.equal(position.lifetimeValue, 50);
    assert.equal(userPosition.balance, 30);
    assert.lengthOf(position.conditions, 1);
    assert.equal(userPosition.position.id, positionIds1[0]);
  });

  step('T1 merge [$10:C1(b|c), $10:C1(a)] -C1-> $10', async () => {
    await conditionalTokens.mergePositions(
      collateralToken.address,
      rootCollectionId,
      conditionId1,
      partition,
      10,
      { from: trader1 }
    );
  });

  step('wait for graph sync', async () => {
    await waitForGraphSync();
  });

  step('check graph T1 C1(b|c) position data', async () => {
    const { position, userPosition } = (
      await subgraphClient.query({
        query: positionAndUserPositionQuery,
        variables: {
          positionId: positionIds1[0],
          userPositionId: toUserPositionId(trader1, positionIds1[0]),
        },
      })
    ).data;
    assert.equal(position.activeValue, 20);
    assert.equal(position.lifetimeValue, 50);
    assert.equal(userPosition.balance, 20);
    assert.lengthOf(position.conditions, 1);
    assert.equal(userPosition.position.id, positionIds1[0]);
  });

  step('check graph T1 C1(a) position data', async () => {
    const { position, userPosition } = (
      await subgraphClient.query({
        query: positionAndUserPositionQuery,
        variables: {
          positionId: positionIds1[1],
          userPositionId: toUserPositionId(trader1, positionIds1[1]),
        },
      })
    ).data;
    assert.equal(position.activeValue, 40);
    assert.equal(position.lifetimeValue, 50);
    assert.equal(userPosition.balance, 40);
    assert.lengthOf(position.conditions, 1);
    assert.equal(userPosition.position.id, positionIds1[1]);
  });

  step('T1 transfers $10:C1(b|c) to T2', async () => {
    // TESTS FOR TRADING POSITIONS
    await conditionalTokens.safeTransferFrom(trader1, trader2, positionIds1[0], 10, '0x', {
      from: trader1,
    });
    assert.equal(await conditionalTokens.balanceOf(trader2, positionIds1[0]), 10);
  });

  step('wait for graph sync', async () => {
    await waitForGraphSync();
  });

  step('check graph T2 C1(b|c) position data', async () => {
    // assert that a new UserPosition and User have been created for trader2
    const trader2UserPositionId = toUserPositionId(trader2, positionIds1[0]);
    const { position, userPosition } = (
      await subgraphClient.query({
        query: positionAndUserPositionQuery,
        variables: {
          positionId: positionIds1[0],
          userPositionId: trader2UserPositionId,
        },
      })
    ).data;
    assert.equal(await conditionalTokens.balanceOf(trader2, positionIds1[0]), 10);
    assert.equal(await conditionalTokens.balanceOf(trader1, positionIds1[0]), 10);
    assert.equal(position.id.toLowerCase(), positionIds1[0]);
    assert.equal(userPosition.balance, 10);
    assert.equal(userPosition.user.id, trader2.toLowerCase());
  });

  step('check graph T2 user data', async () => {
    const { user } = (
      await subgraphClient.query({
        query: userQuery,
        variables: { userId: trader2.toLowerCase() },
      })
    ).data;
    assert.lengthOf(user.userPositions, trader2StartingNumPositions + 1);
    assert.includeMembers(
      user.userPositions.map((userPosition) => '0x' + userPosition.id.slice(42)),
      [positionIds1[0]]
    );
  });

  let positionIds4;
  step('T1 batch transfers [$5:C1(b|c)&C2(b|c), $5:C1(b|c)&C2(a)] to T2', async () => {
    positionIds4 = positionIds2.slice();

    await conditionalTokens.safeBatchTransferFrom(
      trader1,
      trader2,
      positionIds4,
      Array.from({ length: positionIds4.length }, () => 5),
      '0x',
      { from: trader1 }
    );
  });

  step('wait for graph sync', async () => {
    await waitForGraphSync();
  });

  step('check graph T2 user data', async () => {
    const { user } = (
      await subgraphClient.query({
        query: userQuery,
        variables: { userId: trader2.toLowerCase() },
      })
    ).data;
    assert.lengthOf(user.userPositions, trader2StartingNumPositions + 3);
    assert.includeMembers(
      user.userPositions.map((userPosition) => '0x' + userPosition.id.slice(42)),
      [positionIds1[0], ...positionIds2]
    );
  });

  step('check graph T2 C1(b|c)&C2 positions data', async () => {
    for (const [positionId, collectionId] of positionIds4.map((position, i) => [
      position,
      collectionIds2[i],
    ])) {
      const userPositionId = toUserPositionId(trader2, positionId);
      const { position, userPosition } = (
        await subgraphClient.query({
          query: positionAndUserPositionQuery,
          variables: { positionId, userPositionId },
        })
      ).data;
      assert.equal(await conditionalTokens.balanceOf(trader2, positionId), 5);
      assert.equal(await conditionalTokens.balanceOf(trader1, positionId), 15);
      assert.equal(userPosition.balance, 5);
      assert.equal(userPosition.position.id.toLowerCase(), positionId);
      assert.equal(userPosition.user.id, trader2.toLowerCase());

      assert.equal(position.collateralToken.id, collateralToken.address.toLowerCase());
      assert.lengthOf(position.conditions, 2);
      const positionConditionIds = position.conditions.map((condition) => {
        return condition.id;
      });
      assert.sameMembers(positionConditionIds, [conditionId1, conditionId2]);
      assert.equal(position.activeValue, 20);
      assert.equal(position.lifetimeValue, 25);
      assert.equal(position.collection.id, collectionId);
      assert.lengthOf(position.indexSets, 2);
    }
  });

  step('report payouts on conditions', async function () {
    for (const { questionId, payouts } of conditionsInfo) {
      await conditionalTokens.reportPayouts(questionId, payouts, {
        from: oracle,
      });
    }
  });

  step('T2 redeems [C1(b|c)&C2(b|c), C1(b|c)&C2(a)] -C2-> C1(b|c)', async () => {
    await conditionalTokens.redeemPositions(
      collateralToken.address,
      collectionToSplitOn,
      conditionId2,
      partition,
      { from: trader2 }
    );
  });

  step('wait for graph sync', async () => {
    await waitForGraphSync();
  });

  step('check graph T2 C1:(b|c) position data', async () => {
    const { position, userPosition } = (
      await subgraphClient.query({
        query: positionAndUserPositionQuery,
        variables: {
          positionId: positionIds1[0],
          userPositionId: toUserPositionId(trader2, positionIds1[0]),
        },
      })
    ).data;
    assert.equal(await conditionalTokens.balanceOf(trader2, positionIds1[0]), 15);
    assert.equal(await conditionalTokens.balanceOf(trader1, positionIds1[0]), 10);
    assert.equal(position.activeValue, 25);
    assert.equal(position.lifetimeValue, 50);
    assert.lengthOf(position.conditions, 1);
    assert.equal(userPosition.balance, 15);
    assert.equal(userPosition.position.id, positionIds1[0]);
  });

  step('T2 redeems [C1(b|c), C1(a)] -C1-> $', async () => {
    await conditionalTokens.redeemPositions(
      collateralToken.address,
      rootCollectionId,
      conditionId1,
      partition,
      { from: trader2 }
    );
  });

  step('wait for graph sync', async () => {
    await waitForGraphSync();
  });

  step('check graph T2 C1:(b|c) position data', async () => {
    const { position, userPosition } = (
      await subgraphClient.query({
        query: positionAndUserPositionQuery,
        variables: {
          positionId: positionIds1[0],
          userPositionId: toUserPositionId(trader2, positionIds1[0]),
        },
      })
    ).data;
    assert.equal(await conditionalTokens.balanceOf(trader2, positionIds1[0]), 0);
    assert.equal(await conditionalTokens.balanceOf(trader1, positionIds1[0]), 10);
    assert.equal(position.activeValue, 10);
    assert.equal(position.lifetimeValue, 50);
    assert.lengthOf(position.conditions, 1);
    assert.equal(userPosition.balance, 0);
    assert.equal(userPosition.position.id, positionIds1[0]);
  });

  step('check graph collateral data', async () => {
    const { collateralToken: collateralTokenData } = (
      await subgraphClient.query({
        query: collateralTokenQuery,
        variables: {
          collateralId: collateralToken.address.toLowerCase(),
        },
      })
    ).data;
    assert.equal(collateralTokenData.activeAmount, 25);
    assert.equal(collateralTokenData.splitAmount, 50);
    assert.equal(collateralTokenData.mergedAmount, 10);
    assert.equal(collateralTokenData.redeemedAmount, 15);
  });
});
