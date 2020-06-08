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

async function getCondition(conditionId) {
  return (
    await subgraphClient.query({
      query: gql`
        query($conditionId: ID) {
          condition(id: $conditionId) {
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
            creationBlockNumber
            resolveTransaction
            resolveTimestamp
            collections {
              id
            }
          }
        }
      `,
      variables: { conditionId },
    })
  ).data.condition;
}

async function getCollection(collectionId) {
  return (
    await subgraphClient.query({
      query: gql`
        query($collectionId: ID) {
          collection(id: $collectionId) {
            id
            conditions {
              id
            }
            conditionIds
            indexSets
          }
        }
      `,
      variables: { collectionId },
    })
  ).data.collection;
}

async function getPosition(positionId) {
  return (
    await subgraphClient.query({
      query: gql`
        query($positionId: ID) {
          position(id: $positionId) {
            id
            collateralToken
            collection {
              id
            }
            conditions {
              id
            }
            conditionIds
            indexSets
            lifetimeValue
            activeValue
          }
        }
      `,
      variables: { positionId },
    })
  ).data.position;
}

const rootCollectionId = `0x${'0'.repeat(64)}`;

describe('hg-subgraph conditions <> collections <> positions', function () {
  this.timeout(10000);
  let accounts, minter, conditionalTokens, collateralToken;

  before(async function () {
    this.timeout(30000);
    accounts = await web3.eth.getAccounts();
    web3.eth.defaultAccount = minter = accounts[0];
    conditionalTokens = await ConditionalTokens.deployed();
    collateralToken = await ERC20Mintable.new({ from: minter });
    await waitForGraphSync();
  });

  it('allows GraphQL queries', async function () {
    assert(
      await subgraphClient.query({
        query: gql`
          {
            conditions(first: 1) {
              id
            }
          }
        `,
      })
    );
  });

  context('with conditions prepared', function () {
    let conditionsInfo = [];
    beforeEach('prepare conditions', async function () {
      const [creator, oracle] = accounts;

      for (let i = 0; i < 2; i++) {
        const questionId = randomHex(32);
        const outcomeSlotCount = 3;
        const conditionId = getConditionId(oracle, questionId, outcomeSlotCount);

        const {
          tx: createTransaction,
          receipt: { blockNumber: createBlockNumber },
        } = await conditionalTokens.prepareCondition(oracle, questionId, outcomeSlotCount, {
          from: creator,
        });

        const { timestamp: creationTimestamp } = await web3.eth.getBlock(createBlockNumber);

        conditionsInfo[i] = {
          conditionId,

          creator,
          createTransaction,
          createBlockNumber,
          creationTimestamp,

          oracle,
          questionId,
          outcomeSlotCount,
        };
      }
    });

    it('will index conditions', async function () {
      await waitForGraphSync();

      for (const info of conditionsInfo) {
        const condition = await getCondition(info.conditionId);

        assert.deepEqual(condition, {
          __typename: 'Condition',
          id: info.conditionId,
          creator: info.creator.toLowerCase(),
          oracle: info.oracle.toLowerCase(),
          questionId: info.questionId,
          outcomeSlotCount: info.outcomeSlotCount,
          resolved: false,
          payoutNumerators: null,
          payoutDenominator: null,
          createTransaction: info.createTransaction,
          creationTimestamp: info.creationTimestamp.toString(),
          creationBlockNumber: info.createBlockNumber.toString(),
          resolveTransaction: null,
          resolveTimestamp: null,
          collections: [],
        });
      }
    });

    context('with conditions resolved', function () {
      beforeEach('resolve condition', async function () {
        for (const conditionInfo of conditionsInfo) {
          const { oracle, questionId } = conditionInfo;
          const payoutNumerators = [0, 1, 3];
          const {
            tx: resolveTransaction,
            receipt: { blockNumber: resolveBlockNumber },
          } = await conditionalTokens.reportPayouts(questionId, payoutNumerators, { from: oracle });
          const { timestamp: resolutionTimestamp } = await web3.eth.getBlock(resolveBlockNumber);

          Object.assign(conditionInfo, {
            payoutNumerators,
            resolveTransaction,
            resolutionTimestamp,
          });
        }
      });

      it('will index new condition info correctly', async function () {
        await waitForGraphSync();

        for (const info of conditionsInfo) {
          const condition = await getCondition(info.conditionId);

          assert.deepEqual(condition, {
            __typename: 'Condition',
            id: info.conditionId,
            creator: info.creator.toLowerCase(),
            oracle: info.oracle.toLowerCase(),
            questionId: info.questionId,
            outcomeSlotCount: info.outcomeSlotCount,
            resolved: true,
            payoutNumerators: info.payoutNumerators.map((x) => x.toString()),
            payoutDenominator: info.payoutNumerators.reduce((a, b) => a + b, 0).toString(),
            createTransaction: info.createTransaction,
            creationTimestamp: info.creationTimestamp.toString(),
            creationBlockNumber: info.createBlockNumber.toString(),
            resolveTransaction: info.resolveTransaction,
            resolveTimestamp: info.resolutionTimestamp.toString(),
            collections: [],
          });
        }
      });
    });

    context('splitting $ -> C1(a|b), C1(c)', function () {
      let trader;
      beforeEach('mint $100 for trader', async function () {
        trader = accounts[2];
        await collateralToken.mint(trader, 100, { from: minter });
      });

      const partition1 = [0b011, 0b100];
      let split1Info;
      beforeEach('trader splits $100 on condition', async function () {
        await collateralToken.approve(conditionalTokens.address, 100, { from: trader });
        await conditionalTokens.splitPosition(
          collateralToken.address,
          rootCollectionId,
          conditionsInfo[0].conditionId,
          partition1,
          100,
          { from: trader }
        );

        split1Info = partition1.map((indexSet) => {
          const collectionId = getCollectionId(conditionsInfo[0].conditionId, indexSet);
          const positionId = getPositionId(collateralToken.address, collectionId);
          return {
            indexSet,
            collectionId,
            positionId,
          };
        });
      });

      beforeEach('verify chain state after split', async function () {
        for (const { positionId } of split1Info) {
          assert.equal(await conditionalTokens.balanceOf(trader, positionId), 100);
        }

        assert.equal(await collateralToken.balanceOf(trader), 0);
      });

      it('indexes collections and positions related to the split', async function () {
        await waitForGraphSync();

        for (const { collectionId, indexSet } of split1Info) {
          const collection = await getCollection(collectionId);
          assert.deepEqual(collection, {
            __typename: 'Collection',
            id: collectionId,
            conditions: [
              {
                __typename: 'Condition',
                id: conditionsInfo[0].conditionId,
              },
            ],
            conditionIds: [conditionsInfo[0].conditionId],
            indexSets: [indexSet.toString()],
          });
        }

        for (const { positionId, indexSet, collectionId } of split1Info) {
          assert.equal(await conditionalTokens.balanceOf(trader, positionId), 100);
          const position = await getPosition(positionId);

          assert.deepEqual(position, {
            __typename: 'Position',
            id: positionId,
            collateralToken: collateralToken.address.toLowerCase(),
            collection: {
              __typename: 'Collection',
              id: collectionId,
            },
            conditions: [
              {
                __typename: 'Condition',
                id: conditionsInfo[0].conditionId,
              },
            ],
            conditionIds: [conditionsInfo[0].conditionId],
            indexSets: [indexSet.toString()],
            lifetimeValue: '100',
            activeValue: '100',
          });
        }
      });

      context('splitting C1(a|b) -> C1(a), C1(b) positions', function () {
        const partialPartition = [0b001, 0b010];
        let partialPartitionUnion;
        beforeEach('verify partition union targets previous position', function () {
          partialPartitionUnion = partialPartition.reduce((a, b) => a | b, 0);
          assert.equal(partialPartitionUnion, partition1[0]);
        });

        let partialSplitInfo;
        beforeEach('split C1(a|b) -> C1(a), C1(b)', async function () {
          const unionCollectionId = getCollectionId(
            conditionsInfo[0].conditionId,
            partialPartitionUnion
          );

          const unionPositionId = getPositionId(collateralToken.address, unionCollectionId);

          assert.equal(await conditionalTokens.balanceOf(trader, unionPositionId), 100);

          await conditionalTokens.splitPosition(
            collateralToken.address,
            rootCollectionId,
            conditionsInfo[0].conditionId,
            partialPartition,
            100,
            { from: trader }
          );

          const unionInfo = {
            collectionId: unionCollectionId,
            positionId: unionPositionId,
          };

          partialSplitInfo = {
            union: unionInfo,
            children: partialPartition.map((indexSet) => {
              const collectionId = getCollectionId(conditionsInfo[0].conditionId, indexSet);
              const positionId = getPositionId(collateralToken.address, collectionId);
              return {
                union: unionInfo,
                indexSet,
                collectionId,
                positionId,
              };
            }),
          };
        });

        it('updates graph accordingly', async function () {
          await waitForGraphSync();

          const {
            collectionId: unionCollectionId,
            positionId: unionPositionId,
          } = partialSplitInfo.union;

          const unionPosition = await getPosition(unionPositionId);
          assert.deepInclude(unionPosition, {
            __typename: 'Position',
            id: unionPositionId,
            collateralToken: collateralToken.address.toLowerCase(),
            collection: {
              __typename: 'Collection',
              id: unionCollectionId,
            },
            lifetimeValue: '100',
            activeValue: '0',
          });
          assert.equal(unionPosition.conditions.length, 1);
          assert.equal(unionPosition.conditionIds.length, 1);
          assert.equal(unionPosition.indexSets.length, 1);
          assert.deepEqual(
            unionPosition.conditionIds.map((conditionId, i) => ({
              conditionId,
              indexSet: unionPosition.indexSets[i],
            })),
            [
              {
                conditionId: conditionsInfo[0].conditionId,
                indexSet: partialPartitionUnion.toString(),
              },
            ]
          );

          for (const { positionId, collectionId, indexSet } of partialSplitInfo.children) {
            const collection = await getCollection(collectionId);
            assert(collection, `collection ${collectionId} not found`);
            assert.equal(collection.conditions.length, 1);
            assert.equal(collection.conditionIds.length, 1);
            assert.equal(collection.indexSets.length, 1);
            assert.deepEqual(
              collection.conditionIds.map((conditionId, i) => ({
                conditionId,
                indexSet: collection.indexSets[i],
              })),
              [
                {
                  conditionId: conditionsInfo[0].conditionId,
                  indexSet: indexSet.toString(),
                },
              ]
            );
            assert.equal(await conditionalTokens.balanceOf(trader, positionId), 100);
            const position = await getPosition(positionId);

            assert.deepInclude(position, {
              __typename: 'Position',
              id: positionId,
              collateralToken: collateralToken.address.toLowerCase(),
              collection: {
                __typename: 'Collection',
                id: collectionId,
              },
              lifetimeValue: '100',
              activeValue: '100',
            });

            assert.equal(position.conditions.length, position.conditionIds.length);
            assert.equal(position.conditions.length, position.indexSets.length);
            assert.deepEqual(
              position.conditionIds.map((conditionId, i) => ({
                conditionId,
                indexSet: position.indexSets[i],
              })),
              [
                {
                  conditionId: conditionsInfo[0].conditionId,
                  indexSet: indexSet.toString(),
                },
              ]
            );
          }
        });

        context('merging C1(a), C1(b) -> C1(a|b)', async function () {
          beforeEach('merge C1(a), C1(b) -> C1(a|b)', async function () {
            await conditionalTokens.mergePositions(
              collateralToken.address,
              rootCollectionId,
              conditionsInfo[0].conditionId,
              partialPartition,
              100,
              { from: trader }
            );
          });

          it('updates graph accordingly', async function () {
            await waitForGraphSync();

            const {
              collectionId: unionCollectionId,
              positionId: unionPositionId,
            } = partialSplitInfo.union;

            const unionPosition = await getPosition(unionPositionId);
            assert.deepInclude(unionPosition, {
              __typename: 'Position',
              id: unionPositionId,
              collateralToken: collateralToken.address.toLowerCase(),
              collection: {
                __typename: 'Collection',
                id: unionCollectionId,
              },
              lifetimeValue: '100',
              activeValue: '100',
            });
            assert.equal(unionPosition.conditions.length, 1);
            assert.equal(unionPosition.conditionIds.length, 1);
            assert.equal(unionPosition.indexSets.length, 1);
            assert.deepEqual(
              unionPosition.conditionIds.map((conditionId, i) => ({
                conditionId,
                indexSet: unionPosition.indexSets[i],
              })),
              [
                {
                  conditionId: conditionsInfo[0].conditionId,
                  indexSet: partialPartitionUnion.toString(),
                },
              ]
            );

            for (const { positionId, collectionId, indexSet } of partialSplitInfo.children) {
              const collection = await getCollection(collectionId);
              assert(collection, `collection ${collectionId} not found`);
              assert.equal(collection.conditions.length, 1);
              assert.equal(collection.conditionIds.length, 1);
              assert.equal(collection.indexSets.length, 1);
              assert.deepEqual(
                collection.conditionIds.map((conditionId, i) => ({
                  conditionId,
                  indexSet: collection.indexSets[i],
                })),
                [
                  {
                    conditionId: conditionsInfo[0].conditionId,
                    indexSet: indexSet.toString(),
                  },
                ]
              );
              assert.equal(await conditionalTokens.balanceOf(trader, positionId), 0);
              const position = await getPosition(positionId);

              assert.deepInclude(position, {
                __typename: 'Position',
                id: positionId,
                collateralToken: collateralToken.address.toLowerCase(),
                collection: {
                  __typename: 'Collection',
                  id: collectionId,
                },
                lifetimeValue: '100',
                activeValue: '0',
              });

              assert.equal(position.conditions.length, position.conditionIds.length);
              assert.equal(position.conditions.length, position.indexSets.length);
              assert.deepEqual(
                position.conditionIds.map((conditionId, i) => ({
                  conditionId,
                  indexSet: position.indexSets[i],
                })),
                [
                  {
                    conditionId: conditionsInfo[0].conditionId,
                    indexSet: indexSet.toString(),
                  },
                ]
              );
            }
          });
        });

        context('merging C1(b), C1(c) -> C1(b|c)', function () {});
      });

      context('splitting C1 positions -> C1&C2 positions', function () {
        const partition2 = [0b101, 0b010];
        let splits2Info;
        beforeEach('trader splits $100:C1 positions through C2', async function () {
          splits2Info = [];

          const infos = [];
          for (const parent of split1Info) {
            const { collectionId: parentCollectionId } = parent;
            await conditionalTokens.splitPosition(
              collateralToken.address,
              parentCollectionId,
              conditionsInfo[1].conditionId,
              partition2,
              100,
              { from: trader }
            );

            infos.push(
              partition2.map((indexSet) => {
                const collectionId = combineCollectionIds([
                  parentCollectionId,
                  getCollectionId(conditionsInfo[1].conditionId, indexSet),
                ]);
                const positionId = getPositionId(collateralToken.address, collectionId);
                return {
                  parent,
                  indexSet,
                  collectionId,
                  positionId,
                };
              })
            );
          }

          splits2Info = infos.flat();
        });

        it('updates graph accordingly', async function () {
          await waitForGraphSync();

          for (const {
            positionId: parentPositionId,
            collectionId: parentCollectionId,
            indexSet: parentIndexSet,
          } of split1Info) {
            const parentPosition = await getPosition(parentPositionId);

            assert.deepEqual(parentPosition, {
              __typename: 'Position',
              id: parentPositionId,
              collateralToken: collateralToken.address.toLowerCase(),
              collection: {
                __typename: 'Collection',
                id: parentCollectionId,
              },
              conditions: [
                {
                  __typename: 'Condition',
                  id: conditionsInfo[0].conditionId,
                },
              ],
              conditionIds: [conditionsInfo[0].conditionId],
              indexSets: [parentIndexSet.toString()],
              lifetimeValue: '100',
              activeValue: '0',
            });
          }

          for (const {
            parent: { indexSet: parentIndexSet },
            positionId,
            collectionId,
            indexSet,
          } of splits2Info) {
            const collection = await getCollection(collectionId);
            assert(collection, `collection ${collectionId} not found`);
            assert.equal(collection.conditions.length, 2);
            assert.equal(collection.conditionIds.length, 2);
            assert.equal(collection.indexSets.length, 2);
            assert.sameDeepMembers(
              collection.conditionIds.map((conditionId, i) => ({
                conditionId,
                indexSet: collection.indexSets[i],
              })),
              [
                {
                  conditionId: conditionsInfo[0].conditionId,
                  indexSet: parentIndexSet.toString(),
                },
                {
                  conditionId: conditionsInfo[1].conditionId,
                  indexSet: indexSet.toString(),
                },
              ]
            );

            assert.equal(await conditionalTokens.balanceOf(trader, positionId), 100);
            const position = await getPosition(positionId);

            assert.deepInclude(position, {
              __typename: 'Position',
              id: positionId,
              collateralToken: collateralToken.address.toLowerCase(),
              collection: {
                __typename: 'Collection',
                id: collectionId,
              },
              lifetimeValue: '100',
              activeValue: '100',
            });

            assert.equal(position.conditions.length, position.conditionIds.length);
            assert.equal(position.conditions.length, position.indexSets.length);
            assert.sameDeepMembers(
              position.conditionIds.map((conditionId, i) => ({
                conditionId,
                indexSet: position.indexSets[i],
              })),
              [
                {
                  conditionId: conditionsInfo[0].conditionId,
                  indexSet: parentIndexSet.toString(),
                },
                {
                  conditionId: conditionsInfo[1].conditionId,
                  indexSet: indexSet.toString(),
                },
              ]
            );
          }
        });

        context('splitting C1(a|b)&C2 -> C1(a)&C2, C1(b)&C2 positions', function () {
          const partition3 = [0b001, 0b010];
          let partition3Union;
          beforeEach('verify partition union targets previous position', function () {
            partition3Union = partition3.reduce((a, b) => a | b, 0);
            assert.equal(partition3Union, partition1[0]);
          });

          let splits3Info;
          beforeEach('split C1(a|b)&C2 -> C1:(a)&C2, C1(b)&C2', async function () {
            const childrenInfos = [];
            const unionsInfo = [];

            for (const otherIndexSet of partition2) {
              const parentCollectionId = getCollectionId(
                conditionsInfo[1].conditionId,
                otherIndexSet
              );
              const unionCollectionId = combineCollectionIds([
                parentCollectionId,
                getCollectionId(conditionsInfo[0].conditionId, partition3Union),
              ]);

              const unionPositionId = getPositionId(collateralToken.address, unionCollectionId);

              assert.equal(await conditionalTokens.balanceOf(trader, unionPositionId), 100);

              await conditionalTokens.splitPosition(
                collateralToken.address,
                parentCollectionId,
                conditionsInfo[0].conditionId,
                partition3,
                100,
                { from: trader }
              );

              const unionInfo = {
                otherIndexSet,
                collectionId: unionCollectionId,
                positionId: unionPositionId,
              };
              unionsInfo.push(unionInfo);

              childrenInfos.push(
                partition3.map((indexSet) => {
                  const collectionId = combineCollectionIds([
                    parentCollectionId,
                    getCollectionId(conditionsInfo[0].conditionId, indexSet),
                  ]);
                  const positionId = getPositionId(collateralToken.address, collectionId);
                  return {
                    union: unionInfo,
                    indexSet,
                    collectionId,
                    positionId,
                  };
                })
              );
            }
            splits3Info = {
              unions: unionsInfo,
              children: childrenInfos.flat(),
            };
          });

          it('updates graph accordingly', async function () {
            await waitForGraphSync();

            for (const {
              otherIndexSet,
              collectionId: unionCollectionId,
              positionId: unionPositionId,
            } of splits3Info.unions) {
              const unionPosition = await getPosition(unionPositionId);
              assert.deepInclude(unionPosition, {
                __typename: 'Position',
                id: unionPositionId,
                collateralToken: collateralToken.address.toLowerCase(),
                collection: {
                  __typename: 'Collection',
                  id: unionCollectionId,
                },
                lifetimeValue: '100',
                activeValue: '0',
              });
              assert.equal(unionPosition.conditions.length, 2);
              assert.equal(unionPosition.conditionIds.length, 2);
              assert.equal(unionPosition.indexSets.length, 2);
              assert.sameDeepMembers(
                unionPosition.conditionIds.map((conditionId, i) => ({
                  conditionId,
                  indexSet: unionPosition.indexSets[i],
                })),
                [
                  {
                    conditionId: conditionsInfo[0].conditionId,
                    indexSet: partition3Union.toString(),
                  },
                  {
                    conditionId: conditionsInfo[1].conditionId,
                    indexSet: otherIndexSet.toString(),
                  },
                ]
              );
            }

            for (const {
              union: { otherIndexSet },
              positionId,
              collectionId,
              indexSet,
            } of splits3Info.children) {
              const collection = await getCollection(collectionId);
              assert(collection, `collection ${collectionId} not found`);
              assert.equal(collection.conditions.length, 2);
              assert.equal(collection.conditionIds.length, 2);
              assert.equal(collection.indexSets.length, 2);
              assert.sameDeepMembers(
                collection.conditionIds.map((conditionId, i) => ({
                  conditionId,
                  indexSet: collection.indexSets[i],
                })),
                [
                  {
                    conditionId: conditionsInfo[0].conditionId,
                    indexSet: indexSet.toString(),
                  },
                  {
                    conditionId: conditionsInfo[1].conditionId,
                    indexSet: otherIndexSet.toString(),
                  },
                ]
              );
              assert.equal(await conditionalTokens.balanceOf(trader, positionId), 100);
              const position = await getPosition(positionId);

              assert.deepInclude(position, {
                __typename: 'Position',
                id: positionId,
                collateralToken: collateralToken.address.toLowerCase(),
                collection: {
                  __typename: 'Collection',
                  id: collectionId,
                },
                lifetimeValue: '100',
                activeValue: '100',
              });

              assert.equal(position.conditions.length, position.conditionIds.length);
              assert.equal(position.conditions.length, position.indexSets.length);
              assert.sameDeepMembers(
                position.conditionIds.map((conditionId, i) => ({
                  conditionId,
                  indexSet: position.indexSets[i],
                })),
                [
                  {
                    conditionId: conditionsInfo[0].conditionId,
                    indexSet: indexSet.toString(),
                  },
                  {
                    conditionId: conditionsInfo[1].conditionId,
                    indexSet: otherIndexSet.toString(),
                  },
                ]
              );
            }
          });

          context('merging C1(a)&C2, C1(b)&C2 -> C1(a|b)&C2 positions', function () {
            beforeEach('do merge', async function () {
              for (const otherIndexSet of partition2) {
                const parentCollectionId = getCollectionId(
                  conditionsInfo[1].conditionId,
                  otherIndexSet
                );

                await conditionalTokens.mergePositions(
                  collateralToken.address,
                  parentCollectionId,
                  conditionsInfo[0].conditionId,
                  partition3,
                  100,
                  { from: trader }
                );
              }
            });

            it('updates graph accordingly', async function () {
              await waitForGraphSync();

              for (const {
                otherIndexSet,
                collectionId: unionCollectionId,
                positionId: unionPositionId,
              } of splits3Info.unions) {
                const unionPosition = await getPosition(unionPositionId);
                assert.deepInclude(unionPosition, {
                  __typename: 'Position',
                  id: unionPositionId,
                  collateralToken: collateralToken.address.toLowerCase(),
                  collection: {
                    __typename: 'Collection',
                    id: unionCollectionId,
                  },
                  lifetimeValue: '100',
                  activeValue: '100',
                });
                assert.equal(unionPosition.conditions.length, 2);
                assert.equal(unionPosition.conditionIds.length, 2);
                assert.equal(unionPosition.indexSets.length, 2);
                assert.sameDeepMembers(
                  unionPosition.conditionIds.map((conditionId, i) => ({
                    conditionId,
                    indexSet: unionPosition.indexSets[i],
                  })),
                  [
                    {
                      conditionId: conditionsInfo[0].conditionId,
                      indexSet: partition3Union.toString(),
                    },
                    {
                      conditionId: conditionsInfo[1].conditionId,
                      indexSet: otherIndexSet.toString(),
                    },
                  ]
                );
              }

              for (const {
                union: { otherIndexSet },
                positionId,
                collectionId,
                indexSet,
              } of splits3Info.children) {
                const collection = await getCollection(collectionId);
                assert(collection, `collection ${collectionId} not found`);
                assert.equal(collection.conditions.length, 2);
                assert.equal(collection.conditionIds.length, 2);
                assert.equal(collection.indexSets.length, 2);
                assert.sameDeepMembers(
                  collection.conditionIds.map((conditionId, i) => ({
                    conditionId,
                    indexSet: collection.indexSets[i],
                  })),
                  [
                    {
                      conditionId: conditionsInfo[0].conditionId,
                      indexSet: indexSet.toString(),
                    },
                    {
                      conditionId: conditionsInfo[1].conditionId,
                      indexSet: otherIndexSet.toString(),
                    },
                  ]
                );
                assert.equal(await conditionalTokens.balanceOf(trader, positionId), 0);
                const position = await getPosition(positionId);

                assert.deepInclude(position, {
                  __typename: 'Position',
                  id: positionId,
                  collateralToken: collateralToken.address.toLowerCase(),
                  collection: {
                    __typename: 'Collection',
                    id: collectionId,
                  },
                  lifetimeValue: '100',
                  activeValue: '0',
                });

                assert.equal(position.conditions.length, position.conditionIds.length);
                assert.equal(position.conditions.length, position.indexSets.length);
                assert.sameDeepMembers(
                  position.conditionIds.map((conditionId, i) => ({
                    conditionId,
                    indexSet: position.indexSets[i],
                  })),
                  [
                    {
                      conditionId: conditionsInfo[0].conditionId,
                      indexSet: indexSet.toString(),
                    },
                    {
                      conditionId: conditionsInfo[1].conditionId,
                      indexSet: otherIndexSet.toString(),
                    },
                  ]
                );
              }
            });
          });

          context('merging C1(b)&C2, C1(c)&C2 -> C1(b|c)&C2 positions', function () {});
        });

        context('merging C1&C2 -> C1 positions', function () {
          beforeEach('trader splits $100:C1 positions through C2', async function () {
            for (const parent of split1Info) {
              const { collectionId: parentCollectionId } = parent;
              await conditionalTokens.mergePositions(
                collateralToken.address,
                parentCollectionId,
                conditionsInfo[1].conditionId,
                partition2,
                100,
                { from: trader }
              );
            }
          });

          it('updates graph accordingly', async function () {
            await waitForGraphSync();

            for (const {
              positionId: parentPositionId,
              collectionId: parentCollectionId,
              indexSet: parentIndexSet,
            } of split1Info) {
              const parentPosition = await getPosition(parentPositionId);

              assert.deepEqual(parentPosition, {
                __typename: 'Position',
                id: parentPositionId,
                collateralToken: collateralToken.address.toLowerCase(),
                collection: {
                  __typename: 'Collection',
                  id: parentCollectionId,
                },
                conditions: [
                  {
                    __typename: 'Condition',
                    id: conditionsInfo[0].conditionId,
                  },
                ],
                conditionIds: [conditionsInfo[0].conditionId],
                indexSets: [parentIndexSet.toString()],
                lifetimeValue: '100',
                activeValue: '100',
              });
            }

            for (const {
              parent: { indexSet: parentIndexSet },
              positionId,
              collectionId,
              indexSet,
            } of splits2Info) {
              const collection = await getCollection(collectionId);
              assert(collection, `collection ${collectionId} not found`);
              assert.equal(collection.conditions.length, 2);
              assert.equal(collection.conditionIds.length, 2);
              assert.equal(collection.indexSets.length, 2);
              assert.sameDeepMembers(
                collection.conditionIds.map((conditionId, i) => ({
                  conditionId,
                  indexSet: collection.indexSets[i],
                })),
                [
                  {
                    conditionId: conditionsInfo[0].conditionId,
                    indexSet: parentIndexSet.toString(),
                  },
                  {
                    conditionId: conditionsInfo[1].conditionId,
                    indexSet: indexSet.toString(),
                  },
                ]
              );

              assert.equal(await conditionalTokens.balanceOf(trader, positionId), 0);
              const position = await getPosition(positionId);

              assert.deepInclude(position, {
                __typename: 'Position',
                id: positionId,
                collateralToken: collateralToken.address.toLowerCase(),
                collection: {
                  __typename: 'Collection',
                  id: collectionId,
                },
                lifetimeValue: '100',
                activeValue: '0',
              });

              assert.equal(position.conditions.length, position.conditionIds.length);
              assert.equal(position.conditions.length, position.indexSets.length);
              assert.sameDeepMembers(
                position.conditionIds.map((conditionId, i) => ({
                  conditionId,
                  indexSet: position.indexSets[i],
                })),
                [
                  {
                    conditionId: conditionsInfo[0].conditionId,
                    indexSet: parentIndexSet.toString(),
                  },
                  {
                    conditionId: conditionsInfo[1].conditionId,
                    indexSet: indexSet.toString(),
                  },
                ]
              );
            }
          });
        });

        context('merging C1&C2 -> C2 positions', function () {});
      });

      context('merging C1(a|b), C1(c) -> $', function () {
        beforeEach('trader merges on condition to recover $100', async function () {
          await conditionalTokens.mergePositions(
            collateralToken.address,
            rootCollectionId,
            conditionsInfo[0].conditionId,
            partition1,
            100,
            { from: trader }
          );
        });

        it('updates graph accordingly', async function () {
          await waitForGraphSync();

          for (const { positionId, indexSet, collectionId } of split1Info) {
            assert.equal(await conditionalTokens.balanceOf(trader, positionId), 0);
            const position = await getPosition(positionId);

            assert.deepEqual(position, {
              __typename: 'Position',
              id: positionId,
              collateralToken: collateralToken.address.toLowerCase(),
              collection: {
                __typename: 'Collection',
                id: collectionId,
              },
              conditions: [
                {
                  __typename: 'Condition',
                  id: conditionsInfo[0].conditionId,
                },
              ],
              conditionIds: [conditionsInfo[0].conditionId],
              indexSets: [indexSet.toString()],
              lifetimeValue: '100',
              activeValue: '0',
            });
          }
        });
      });
    });
  });
});
