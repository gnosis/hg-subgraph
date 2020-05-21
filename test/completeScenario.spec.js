const { assert } = require('chai');
const axios = require('axios');
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

const { waitForGraphSync } = require('./utils')({ web3 });

describe('Complete scenario tests for accurate mappings', function () {
  this.timeout(20000);
  let accounts, conditionalTokens, collateralToken, minter, globalConditionId, globalConditionId2;

  before(async function () {
    this.timeout(30000);
    accounts = await web3.eth.getAccounts();
    web3.eth.defaultAccount = minter = accounts[0];
    conditionalTokens = await ConditionalTokens.deployed();
    collateralToken = await ERC20Mintable.new({ from: minter });
    const [creator, oracle] = accounts;
    const conditionsInfo = Array.from({ length: 2 }, () => {
      const questionId = randomHex(32);
      const outcomeSlotCount = 3;
      const conditionId = getConditionId(oracle, questionId, outcomeSlotCount);
      return { questionId, outcomeSlotCount, conditionId };
    });
    await conditionalTokens.prepareCondition(
      oracle,
      conditionsInfo[0].questionId,
      conditionsInfo[0].outcomeSlotCount,
      { from: creator }
    );
    await conditionalTokens.prepareCondition(
      oracle,
      conditionsInfo[1].questionId,
      conditionsInfo[1].outcomeSlotCount,
      { from: creator }
    );
    await conditionalTokens.reportPayouts(conditionsInfo[0].questionId, [0, 1, 0], {
      from: oracle,
    });
    await conditionalTokens.reportPayouts(conditionsInfo[1].questionId, [0, 1, 0], {
      from: oracle,
    });
    globalConditionId = conditionsInfo[0].conditionId;
    globalConditionId2 = conditionsInfo[1].conditionId;
    await waitForGraphSync();
  });

  it('Should keep track of the mappings properly', async () => {
    const [trader, trader2] = accounts;
    await collateralToken.mint(trader, 100, { from: minter });
    assert.equal(await collateralToken.balanceOf(trader), 100);
    await collateralToken.approve(conditionalTokens.address, 100, { from: trader });
    const partition = [0b110, 0b01];

    await conditionalTokens.splitPosition(
      collateralToken.address,
      '0x0000000000000000000000000000000000000000000000000000000000000000',
      globalConditionId,
      partition,
      50,
      { from: trader }
    );
    await waitForGraphSync();

    const collectionIds = partition.map((indexSet) => getCollectionId(globalConditionId, indexSet));

    const positionIds = collectionIds.map((collectionId) =>
      getPositionId(collateralToken.address, collectionId)
    );

    let collateralData = (
      await axios.post(`http://localhost:8000/subgraphs/name/gnosis/hg`, {
        query: `{
          collateral(id: "${collateralToken.address.toLowerCase()}") {
            id
            splitCollateral
            redeemedCollateral
          }
        }`,
      })
    ).data.data;
    assert.equal(collateralData.collateral.splitCollateral, 50);
    assert.equal(collateralData.collateral.redeemedCollateral, 0);

    for (const [positionId, collectionId] of positionIds.map((p, i) => [p, collectionIds[i]])) {
      assert.equal(await conditionalTokens.balanceOf(trader, positionId), 50);
      const userPositionId = (trader + positionId.slice(2)).toLowerCase();
      const userPositionGraphData = (
        await axios.post(`http://localhost:8000/subgraphs/name/gnosis/hg`, {
          query: `{
            userPositions(where: {id: "${userPositionId}"}) {
              balance
              position { id }
              user { id }
            }
          }`,
        })
      ).data.data.userPositions[0];
      assert.equal(userPositionGraphData.balance, 50);
      assert.equal(userPositionGraphData.position.id, positionId);
      assert.equal(userPositionGraphData.user.id, trader.toLowerCase());

      const positionGraphData = (
        await axios.post(`http://localhost:8000/subgraphs/name/gnosis/hg`, {
          query: `{
            position(id: "${positionId}") {
              collateralToken
              collection { id }
              conditions { id }
              indexSets
              lifetimeValue
              activeValue
            }
          }`,
        })
      ).data.data.position;
      assert(positionGraphData, "Positions weren't created in The Graph");
      assert.equal(positionGraphData.activeValue, 50);
      assert.equal(positionGraphData.lifetimeValue, 50);
      assert.equal(positionGraphData.collection.id, collectionId);
      assert.include(partition, parseInt(positionGraphData.indexSets[0]));
      assert.lengthOf(positionGraphData.indexSets, 1);
      assert.lengthOf(positionGraphData.conditions, 1);
      assert.equal(positionGraphData.collateralToken, collateralToken.address.toLowerCase());
    }

    let userGraphData = (
      await axios.post(`http://localhost:8000/subgraphs/name/gnosis/hg`, {
        query: `{
          user(id: "${trader.toLowerCase()}") {
            id
            userPositions { id }
            participatedConditions { id }
            firstParticipation
            lastActive
          }
        }`,
      })
    ).data.data.user;

    assert.lengthOf(
      userGraphData.participatedConditions,
      1,
      "User.ParticipatedConditions length isn't accurate"
    );
    assert.lengthOf(userGraphData.userPositions, 2, "User.UserPositions length isn't accurate");
    let userGraphDataConditions = userGraphData.participatedConditions.map((condition) => {
      return condition.id;
    });
    assert.sameMembers(userGraphDataConditions, [globalConditionId]);
    assert.lengthOf(userGraphData.userPositions, 2, "User.UserPositions length isn't accurate");
    assert.sameMembers(
      userGraphData.userPositions.map((userPosition) => '0x' + userPosition.id.slice(42)),
      [...positionIds]
    );

    // split a position from another collectionId --> make sure split adds the all the new UserPosition balances AND subtracts from the former UserPosition
    const collectionToSplitOn = collectionIds[0];
    const collectionNotSplitOn = collectionIds[1];

    await conditionalTokens.splitPosition(
      collateralToken.address,
      collectionToSplitOn,
      globalConditionId2,
      partition,
      25,
      { from: trader }
    );
    await waitForGraphSync();

    const collectionIds2 = partition.map((indexSet) =>
      combineCollectionIds([collectionToSplitOn, getCollectionId(globalConditionId2, indexSet)])
    );

    const positionIds2 = collectionIds2.map((collectionId) =>
      getPositionId(collateralToken.address, collectionId)
    );

    userGraphData = (
      await axios.post(`http://localhost:8000/subgraphs/name/gnosis/hg`, {
        query: `{
        user(id: "${trader.toLowerCase()}") {
          id
          userPositions { id }
          participatedConditions { id }
          firstParticipation
          lastActive
        }
      }`,
      })
    ).data.data.user;
    assert.lengthOf(
      userGraphData.participatedConditions,
      2,
      "User.ParticipatedConditions length isn't accurate"
    );
    assert.lengthOf(userGraphData.userPositions, 4, "User.UserPositions length isn't accurate");
    userGraphDataConditions = userGraphData.participatedConditions.map((condition) => {
      return condition.id;
    });
    assert.sameMembers(userGraphDataConditions, [globalConditionId, globalConditionId2]);
    assert.sameMembers(
      userGraphData.userPositions.map((userPosition) => '0x' + userPosition.id.slice(42)),
      [...positionIds, ...positionIds2]
    );

    // // verify that parentPosition is -25
    const parentPositionFromSplit = getPositionId(collateralToken.address, collectionToSplitOn);
    assert.equal(await conditionalTokens.balanceOf(trader, parentPositionFromSplit), 25);
    const parentPositionFromSplitUserPosition = (
      trader + parentPositionFromSplit.slice(2)
    ).toLowerCase();
    let splitPositionGraphData = (
      await axios.post(`http://localhost:8000/subgraphs/name/gnosis/hg`, {
        query: `{
          position(id: "${parentPositionFromSplit}") {
            id
            activeValue
            lifetimeValue
          }
          userPositions(where: {id: "${parentPositionFromSplitUserPosition}"}) {
            id
            balance
            position { id }
            user { id }
          }
        }`,
      })
    ).data.data;
    assert.equal(splitPositionGraphData.position.lifetimeValue, 50);
    assert.equal(splitPositionGraphData.position.activeValue, 25);
    assert.equal(splitPositionGraphData.userPositions[0].balance, 25);
    assert.include(positionIds, splitPositionGraphData.userPositions[0].position.id);
    assert.equal(splitPositionGraphData.userPositions[0].user.id, trader.toLowerCase());

    // Verifies that the position that wasn't affected by the 2nd split is still stored correctly
    const notSplitPosition = getPositionId(collateralToken.address, collectionNotSplitOn);
    const usernotSplitPosition = (trader + notSplitPosition.slice(2)).toLowerCase();
    assert.equal(await conditionalTokens.balanceOf(trader, notSplitPosition), 50);
    let notSplitPositionGraphData = (
      await axios.post(`http://localhost:8000/subgraphs/name/gnosis/hg`, {
        query: `{
          position(id: "${notSplitPosition}") {
            id
            activeValue
            lifetimeValue
          }
          userPositions(where: {id: "${usernotSplitPosition}"}) {
            id
            balance
            position { id }
            user { id }
          }
        }`,
      })
    ).data.data;
    assert.equal(notSplitPositionGraphData.position.lifetimeValue, 50);
    assert.equal(notSplitPositionGraphData.position.activeValue, 50);
    assert.equal(notSplitPositionGraphData.position.id, notSplitPosition.toLowerCase());
    assert.equal(notSplitPositionGraphData.userPositions[0].balance, 50);
    assert.equal(notSplitPositionGraphData.userPositions[0].position.id, notSplitPosition);

    for (const [positionId, collectionId] of positionIds2.map((posId, i) => [
      posId,
      collectionIds2[i],
    ])) {
      assert.equal(await conditionalTokens.balanceOf(trader, positionId), 25);
      const userPositionId = (trader + positionId.slice(2)).toLowerCase();
      let userPositionGraphData = (
        await axios.post(`http://localhost:8000/subgraphs/name/gnosis/hg`, {
          query: `{
            userPositions(where: {id: "${userPositionId}"}) {
              balance
              position { id }
              user { id }
            }
          }`,
        })
      ).data.data.userPositions[0];
      assert.equal(userPositionGraphData.balance, 25);
      assert.equal(userPositionGraphData.position.id, positionId);
      assert.equal(userPositionGraphData.user.id, trader.toLowerCase());

      let positionGraphData = (
        await axios.post(`http://localhost:8000/subgraphs/name/gnosis/hg`, {
          query: `{
            position(id: "${positionId}") {
              collateralToken
              collection { id }
              conditions { id }
              indexSets
              lifetimeValue
              activeValue
            }
          }`,
        })
      ).data.data.position;
      assert.equal(positionGraphData.collateralToken, collateralToken.address.toLowerCase());
      assert.lengthOf(positionGraphData.conditions, 2);
      const positionGraphDataconditionIds = positionGraphData.conditions.map((condition) => {
        return condition.id;
      });
      assert.sameMembers(positionGraphDataconditionIds, [
        globalConditionId.toLowerCase(),
        globalConditionId2.toLowerCase(),
      ]);
      assert.equal(positionGraphData.activeValue, 25);
      assert.equal(positionGraphData.collection.id, collectionId);
      assert.include(partition, parseInt(positionGraphData.indexSets));
      assert.lengthOf(positionGraphData.indexSets, 2);
    }

    // split a position from a different position on the same condition --> make sure split subtracts correctly from the parentIndex and adds to the appropriate list of new indexes, make sure split doesn't add to the full index set

    // split 6 into 4 and 2
    const partition2 = [0b100, 0b10];

    await conditionalTokens.splitPosition(
      collateralToken.address,
      '0x00',
      globalConditionId,
      partition2,
      5,
      { from: trader }
    );
    await waitForGraphSync();

    const collectionIds3 = partition2.map((indexSet) =>
      getCollectionId(globalConditionId, indexSet)
    );

    const positionIds3 = collectionIds3.map((collectionId) =>
      getPositionId(collateralToken.address, collectionId)
    );

    assert.equal(await conditionalTokens.balanceOf(trader, positionIds[0]), 20);
    assert.equal(await conditionalTokens.balanceOf(trader, positionIds[1]), 50);

    userGraphData = (
      await axios.post(`http://localhost:8000/subgraphs/name/gnosis/hg`, {
        query: `{
        user(id: "${trader.toLowerCase()}") {
          id
          userPositions { id }
          participatedConditions { id }
          firstParticipation
          lastActive
        }
      }`,
      })
    ).data.data.user;

    assert.lengthOf(
      userGraphData.participatedConditions,
      2,
      "User.ParticipatedConditions length isn't accurate"
    );
    userGraphDataConditions = userGraphData.participatedConditions.map((condition) => {
      return condition.id;
    });
    assert.includeMembers(userGraphDataConditions, [globalConditionId, globalConditionId2]);
    assert.lengthOf(userGraphData.userPositions, 6, "User.UserPositions length isn't accurate");
    assert.includeMembers(
      userGraphData.userPositions.map((userPosition) => '0x' + userPosition.id.slice(42)),
      [...positionIds, ...positionIds2, ...positionIds3]
    );

    let positionGraphData;

    for (const [positionId, collectionId] of positionIds3.map((p, i) => [p, collectionIds3[i]])) {
      assert.equal(await conditionalTokens.balanceOf(trader, positionId), 5);
      const userPositionId = (trader + positionId.slice(2)).toLowerCase();
      let userPositionGraphData = (
        await axios.post(`http://localhost:8000/subgraphs/name/gnosis/hg`, {
          query: `{
            userPositions(where: {id: "${userPositionId}"}) {
              balance
              position { id }
              user { id }
            }
          }`,
        })
      ).data.data.userPositions[0];
      assert.equal(userPositionGraphData.balance, 5);
      assert.equal(userPositionGraphData.position.id, positionId);
      assert.equal(userPositionGraphData.user.id, trader.toLowerCase());

      positionGraphData = (
        await axios.post(`http://localhost:8000/subgraphs/name/gnosis/hg`, {
          query: `{
            position(id: "${positionId}") {
              collateralToken
              collection { id }
              conditions { id }
              indexSets
              lifetimeValue
              activeValue
            }
          }`,
        })
      ).data.data.position;

      assert.equal(positionGraphData.collateralToken, collateralToken.address.toLowerCase());
      assert.lengthOf(positionGraphData.conditions, 1);
      const positionGraphDataconditionIds = positionGraphData.conditions.map((condition) => {
        return condition.id;
      });
      assert.sameMembers(positionGraphDataconditionIds, [globalConditionId.toLowerCase()]);
      assert.equal(positionGraphData.activeValue, 5);
      assert.equal(positionGraphData.collection.id, collectionId);
      assert.lengthOf(positionGraphData.indexSets, 2);
    }

    positionGraphData = (
      await axios.post(`http://localhost:8000/subgraphs/name/gnosis/hg`, {
        query: `{
          position(id: "${positionIds[0]}") {
            id
            conditions { id }
            collection { id indexSets }
            indexSets
            lifetimeValue
            activeValue
          }
          userPosition(id: "${(trader + positionIds[0].slice(2)).toLowerCase()}") {
            balance
            position { id }
            user { id }
          }
        }`,
      })
    ).data.data;
    assert.equal(positionGraphData.position.activeValue, 20);
    assert.equal(positionGraphData.position.lifetimeValue, 50);
    assert.equal(positionGraphData.userPosition.balance, 20);
    assert.lengthOf(positionGraphData.position.conditions, 1);
    assert.equal(positionGraphData.userPosition.position.id, positionIds[0]);

    // SECTION: Tests for merging tokens
    await conditionalTokens.mergePositions(
      collateralToken.address,
      '0x00',
      globalConditionId,
      partition2,
      5,
      { from: trader }
    );
    await waitForGraphSync();

    for (const [positionId, collectionId] of positionIds3.map((p, i) => [p, collectionIds3[i]])) {
      assert.equal(await conditionalTokens.balanceOf(trader, positionId), 0);
      const userPositionId = (trader + positionId.slice(2)).toLowerCase();
      let userPositionGraphData = (
        await axios.post(`http://localhost:8000/subgraphs/name/gnosis/hg`, {
          query: `{
            userPositions(where: {id: "${userPositionId}"}) {
              balance
              position { id }
              user { id }
            }
          }`,
        })
      ).data.data.userPositions[0];
      assert.equal(userPositionGraphData.balance, 0);
      assert.equal(userPositionGraphData.position.id, positionId);
      assert.equal(userPositionGraphData.user.id, trader.toLowerCase());

      positionGraphData = (
        await axios.post(`http://localhost:8000/subgraphs/name/gnosis/hg`, {
          query: `{
            position(id: "${positionId}") {
              collateralToken
              collection { id }
              conditions { id }
              indexSets
              lifetimeValue
              activeValue
            }
          }`,
        })
      ).data.data.position;

      assert.equal(positionGraphData.collateralToken, collateralToken.address.toLowerCase());
      assert.lengthOf(positionGraphData.conditions, 1);
      const positionGraphDataconditionIds = positionGraphData.conditions.map((condition) => {
        return condition.id;
      });
      assert.sameMembers(positionGraphDataconditionIds, [globalConditionId.toLowerCase()]);
      assert.equal(positionGraphData.activeValue, 0);
      assert.equal(positionGraphData.lifetimeValue, 5);
      assert.equal(positionGraphData.collection.id, collectionId);
      assert.lengthOf(positionGraphData.indexSets, 2);
    }

    await conditionalTokens.mergePositions(
      collateralToken.address,
      collectionToSplitOn,
      globalConditionId2,
      partition,
      5,
      { from: trader }
    );
    await waitForGraphSync();

    for (const [positionId, collectionId] of positionIds2.map((posId, i) => [
      posId,
      collectionIds2[i],
    ])) {
      assert.equal(await conditionalTokens.balanceOf(trader, positionId), 20);
      const userPositionId = (trader + positionId.slice(2)).toLowerCase();
      let userPositionGraphData = (
        await axios.post(`http://localhost:8000/subgraphs/name/gnosis/hg`, {
          query: `{
            userPositions(where: {id: "${userPositionId}"}) {
              balance
              position { id }
              user { id }
            }
          }`,
        })
      ).data.data.userPositions[0];
      assert.equal(userPositionGraphData.balance, 20);
      assert.equal(userPositionGraphData.position.id, positionId);
      assert.equal(userPositionGraphData.user.id, trader.toLowerCase());

      let positionGraphData = (
        await axios.post(`http://localhost:8000/subgraphs/name/gnosis/hg`, {
          query: `{
            position(id: "${positionId}") {
              collateralToken
              collection { id }
              conditions { id }
              indexSets
              lifetimeValue
              activeValue
            }
          }`,
        })
      ).data.data.position;
      assert.equal(positionGraphData.collateralToken, collateralToken.address.toLowerCase());
      assert.lengthOf(positionGraphData.conditions, 2);
      const positionGraphDataconditionIds = positionGraphData.conditions.map((condition) => {
        return condition.id;
      });
      assert.sameMembers(positionGraphDataconditionIds, [
        globalConditionId.toLowerCase(),
        globalConditionId2.toLowerCase(),
      ]);
      assert.equal(positionGraphData.activeValue, 20);
      assert.equal(positionGraphData.lifetimeValue, 25);
      assert.equal(positionGraphData.collection.id, collectionId);
      assert.include(partition, parseInt(positionGraphData.indexSets));
      assert.lengthOf(positionGraphData.indexSets, 2);
    }

    positionGraphData = (
      await axios.post(`http://localhost:8000/subgraphs/name/gnosis/hg`, {
        query: `{
          position(id: "${positionIds[0]}") {
            id
            conditions { id }
            collection { id indexSets }
            indexSets
            lifetimeValue
            activeValue
          }
          userPosition(id: "${(trader + positionIds[0].slice(2)).toLowerCase()}") {
            balance
            position { id }
            user { id }
          }
        }`,
      })
    ).data.data;
    assert.equal(positionGraphData.position.activeValue, 30);
    assert.equal(positionGraphData.position.lifetimeValue, 50);
    assert.equal(positionGraphData.userPosition.balance, 30);
    assert.lengthOf(positionGraphData.position.conditions, 1);
    assert.equal(positionGraphData.userPosition.position.id, positionIds[0]);

    await conditionalTokens.mergePositions(
      collateralToken.address,
      '0x00',
      globalConditionId,
      partition,
      10,
      { from: trader }
    );
    await waitForGraphSync();

    positionGraphData = (
      await axios.post(`http://localhost:8000/subgraphs/name/gnosis/hg`, {
        query: `{
          position(id: "${positionIds[0]}") {
            id
            conditions { id }
            collection { id indexSets }
            indexSets
            lifetimeValue
            activeValue
          }
          userPosition(id: "${(trader + positionIds[0].slice(2)).toLowerCase()}") {
            balance
            position { id }
            user { id }
          }
        }`,
      })
    ).data.data;
    assert.equal(positionGraphData.position.activeValue, 20);
    assert.equal(positionGraphData.position.lifetimeValue, 50);
    assert.equal(positionGraphData.userPosition.balance, 20);
    assert.lengthOf(positionGraphData.position.conditions, 1);
    assert.equal(positionGraphData.userPosition.position.id, positionIds[0]);

    positionGraphData = (
      await axios.post(`http://localhost:8000/subgraphs/name/gnosis/hg`, {
        query: `{
          position(id: "${positionIds[1]}") {
            id
            conditions { id }
            collection { id indexSets }
            indexSets
            lifetimeValue
            activeValue
          }
          userPosition(id: "${(trader + positionIds[1].slice(2)).toLowerCase()}") {
            balance
            position { id }
            user { id }
          }
        }`,
      })
    ).data.data;
    assert.equal(positionGraphData.position.activeValue, 40);
    assert.equal(positionGraphData.position.lifetimeValue, 50);
    assert.equal(positionGraphData.userPosition.balance, 40);
    assert.lengthOf(positionGraphData.position.conditions, 1);
    assert.equal(positionGraphData.userPosition.position.id, positionIds[1]);

    // TESTS FOR TRADING POSITIONS
    await conditionalTokens.safeTransferFrom(trader, trader2, positionIds[0], 10, '0x00', {
      from: trader,
    });
    await waitForGraphSync();

    assert.equal(await conditionalTokens.balanceOf(trader2, positionIds[0]), 10);

    // assert that a new UserPosition and User have been created for trader2
    const trader2UserPositionId = (trader2 + positionIds[0].slice(2)).toLowerCase();
    let trader2UserPositionData = (
      await axios.post(`http://localhost:8000/subgraphs/name/gnosis/hg`, {
        query: `{
          position(id: "${positionIds[0]}") {
            id
            activeValue
            lifetimeValue
          }
          userPosition(id: "${trader2UserPositionId}") {
            balance
            position { id }
            user { id }
          }
        }`,
      })
    ).data.data;
    assert.equal(await conditionalTokens.balanceOf(trader2, positionIds[0]), 10);
    assert.equal(await conditionalTokens.balanceOf(trader, positionIds[0]), 10);
    assert.equal(trader2UserPositionData.position.id.toLowerCase(), positionIds[0]);
    assert.equal(trader2UserPositionData.userPosition.balance, 10);
    assert.equal(trader2UserPositionData.userPosition.user.id, trader2.toLowerCase());

    let user2GraphData = (
      await axios.post(`http://localhost:8000/subgraphs/name/gnosis/hg`, {
        query: `{
          user(id: "${trader2.toLowerCase()}") {
            id
            userPositions { id }
            participatedConditions { id }
            firstParticipation
            lastActive
          }
        }`,
      })
    ).data.data.user;
    assert.lengthOf(
      user2GraphData.participatedConditions,
      1,
      "User.ParticipatedConditions length isn't accurate"
    );
    assert.lengthOf(user2GraphData.userPositions, 1, "User.UserPositions length isn't accurate");
    userGraphDataConditions = user2GraphData.participatedConditions.map((condition) => {
      return condition.id;
    });
    assert.sameMembers(userGraphDataConditions, [globalConditionId]);
    assert.sameMembers(
      user2GraphData.userPositions.map((userPosition) => '0x' + userPosition.id.slice(42)),
      [positionIds[0]]
    );

    // // TESTS FOR BATCH TRADING OF DIFFERENT OUTCOME TOKENS
    const positionIds4 = positionIds2.slice();

    await conditionalTokens.safeBatchTransferFrom(
      trader,
      trader2,
      positionIds4,
      Array.from({ length: positionIds4.length }, () => 5),
      '0x00',
      { from: trader }
    );
    await waitForGraphSync();

    user2GraphData = (
      await axios.post(`http://localhost:8000/subgraphs/name/gnosis/hg`, {
        query: `{
          user(id: "${trader2.toLowerCase()}") {
            id
            userPositions { id }
            participatedConditions { id }
            firstParticipation
            lastActive
          }
        }`,
      })
    ).data.data.user;
    assert.lengthOf(
      user2GraphData.participatedConditions,
      2,
      "User.ParticipatedConditions length isn't accurate"
    );
    assert.lengthOf(user2GraphData.userPositions, 3, "User.UserPositions length isn't accurate");
    userGraphDataConditions = user2GraphData.participatedConditions.map((condition) => {
      return condition.id;
    });
    assert.sameMembers(userGraphDataConditions, [globalConditionId, globalConditionId2]);
    assert.sameMembers(
      user2GraphData.userPositions.map((userPosition) => '0x' + userPosition.id.slice(42)),
      [positionIds[0], ...positionIds2]
    );

    for (const [positionId, collectionId] of positionIds4.map((position, i) => [
      position,
      collectionIds2[i],
    ])) {
      const userPositionId = (trader2 + positionId.slice(2)).toLowerCase();
      let batchTransferUserPositionsData = (
        await axios.post(`http://localhost:8000/subgraphs/name/gnosis/hg`, {
          query: `{
            position(id: "${positionId}") { id }
            userPosition(id: "${userPositionId}") {
              balance
              position { id }
              user { id }
            }
          }`,
        })
      ).data.data;
      assert.equal(await conditionalTokens.balanceOf(trader2, positionId), 5);
      assert.equal(await conditionalTokens.balanceOf(trader, positionId), 15);
      assert.equal(batchTransferUserPositionsData.userPosition.balance, 5);
      assert.equal(
        batchTransferUserPositionsData.userPosition.position.id.toLowerCase(),
        positionId
      );
      assert.equal(batchTransferUserPositionsData.userPosition.user.id, trader2.toLowerCase());

      let positionGraphData = (
        await axios.post(`http://localhost:8000/subgraphs/name/gnosis/hg`, {
          query: `{
            position(id: "${positionId}") {
              collateralToken
              collection { id }
              conditions { id }
              indexSets
              lifetimeValue
              activeValue
            }
          }`,
        })
      ).data.data.position;

      assert.equal(positionGraphData.collateralToken, collateralToken.address.toLowerCase());
      assert.lengthOf(positionGraphData.conditions, 2);
      const positionGraphDataconditionIds = positionGraphData.conditions.map((condition) => {
        return condition.id;
      });
      assert.sameMembers(positionGraphDataconditionIds, [
        globalConditionId.toLowerCase(),
        globalConditionId2.toLowerCase(),
      ]);
      assert.equal(positionGraphData.activeValue, 20);
      assert.equal(positionGraphData.lifetimeValue, 25);
      assert.equal(positionGraphData.collection.id, collectionId);
      assert.lengthOf(positionGraphData.indexSets, 2);
    }

    await conditionalTokens.redeemPositions(
      collateralToken.address,
      collectionToSplitOn,
      globalConditionId2,
      partition,
      { from: trader2 }
    );
    await waitForGraphSync();

    positionGraphData = (
      await axios.post(`http://localhost:8000/subgraphs/name/gnosis/hg`, {
        query: `{
          position(id: "${positionIds[0]}") {
            id
            conditions { id }
            collection { id indexSets }
            indexSets
            lifetimeValue
            activeValue
          }
          userPosition(id: "${(trader2 + positionIds[0].slice(2)).toLowerCase()}") {
            balance
            position { id }
            user { id }
          }
        }`,
      })
    ).data.data;
    assert.equal(await conditionalTokens.balanceOf(trader2, positionIds[0]), 15);
    assert.equal(await conditionalTokens.balanceOf(trader, positionIds[0]), 10);
    assert.equal(positionGraphData.position.activeValue, 25);
    assert.equal(positionGraphData.position.lifetimeValue, 50);
    assert.lengthOf(positionGraphData.position.conditions, 1);
    assert.equal(positionGraphData.userPosition.balance, 15);
    assert.equal(positionGraphData.userPosition.position.id, positionIds[0]);

    await conditionalTokens.redeemPositions(
      collateralToken.address,
      '0x00',
      globalConditionId,
      partition,
      { from: trader2 }
    );
    await waitForGraphSync();

    positionGraphData = (
      await axios.post(`http://localhost:8000/subgraphs/name/gnosis/hg`, {
        query: `{
          position(id: "${positionIds[0]}") {
            id
            conditions { id }
            collection { id indexSets }
            indexSets
            lifetimeValue
            activeValue
          }
          userPosition(id: "${(trader2 + positionIds[0].slice(2)).toLowerCase()}") {
            balance
            position { id }
            user { id }
          }
        }`,
      })
    ).data.data;
    assert.equal(await conditionalTokens.balanceOf(trader2, positionIds[0]), 0);
    assert.equal(await conditionalTokens.balanceOf(trader, positionIds[0]), 10);
    assert.equal(positionGraphData.position.activeValue, 10);
    assert.equal(positionGraphData.position.lifetimeValue, 50);
    assert.lengthOf(positionGraphData.position.conditions, 1);
    assert.equal(positionGraphData.userPosition.balance, 0);
    assert.equal(positionGraphData.userPosition.position.id, positionIds[0]);

    collateralData = (
      await axios.post(`http://localhost:8000/subgraphs/name/gnosis/hg`, {
        query: `{
          collateral(id: "${collateralToken.address.toLowerCase()}") {
            id
            splitCollateral
            redeemedCollateral
          }
        }`,
      })
    ).data.data;
    assert.equal(collateralData.collateral.splitCollateral, 50);
    assert.equal(collateralData.collateral.redeemedCollateral, 25);
  });
});
