import { crypto, log, Address, BigInt, Bytes } from '@graphprotocol/graph-ts';
import {
  PositionSplit,
  PositionsMerge,
  PayoutRedemption,
  ConditionalTokens
} from '../generated/ConditionalTokens/ConditionalTokens';

import { Condition, CollateralToken, Collection, Position, UserPosition } from '../generated/schema';

import { sum, zeroAsBigInt, concat, touchUser, zeroAddress, requireGlobal } from './utils';

function isFullIndexSet(indexSet: BigInt, outcomeSlotCount: i32): boolean {
  for (let i = 0; i < indexSet.length && 8 * i < outcomeSlotCount; i++) {
    let bitsLeft = outcomeSlotCount - 8 * i;
    if (bitsLeft < 8) {
      if (indexSet[i] != (1 << (bitsLeft as u8)) - 1) return false;
    } else {
      if (indexSet[i] != 0xff) return false;
    }
  }
  return true;
}

function isZeroCollectionId(collectionId: Bytes): boolean {
  for (let i = 0; i < collectionId.length; i++) if (collectionId[i] != 0) return false;
  return true;
}

function toPositionId(collateralToken: Address, collectionId: Bytes): Bytes {
  let hashPayload = new Uint8Array(52);
  hashPayload.fill(0);
  for (let i = 0; i < collateralToken.length && i < 20; i++) {
    hashPayload[i] = collateralToken[i];
  }
  for (let i = 0; i < collectionId.length && i < 32; i++) {
    hashPayload[i + 20] = collectionId[i];
  }
  return crypto.keccak256(hashPayload as Bytes) as Bytes;
}

enum SubtreeOperation {
  Split,
  Merge,
  Redeem,
}

class CollectionInfo {
  conditions: string[];
  indexSets: BigInt[];
  multiplicities: i32[];

  constructor(conditions: string[], indexSets: BigInt[], multiplicities: i32[]) {
    this.conditions = conditions;
    this.indexSets = indexSets;
    this.multiplicities = multiplicities;
  }

  mod(
    modConditionId: string,
    modIndexSet: BigInt,
    modDirection: i32,
  ): CollectionInfo {
    let conditions = this.conditions;
    let indexSets = this.indexSets;
    let multiplicities = this.multiplicities;

    let collectionIndex = -1;
    for (let i = 0; i < conditions.length; i++) {
      if (
        conditions[i] == modConditionId &&
        indexSets[i].equals(modIndexSet)
      ) {
        collectionIndex = i;
        break;
      }
    }

    let moddedConditions: string[];
    let moddedIndexSets: BigInt[];
    let moddedMultiplicities: i32[];

    if (collectionIndex < 0) {
      let numEntries = conditions.length + 1;
      moddedConditions = new Array<string>(numEntries);
      moddedIndexSets = new Array<BigInt>(numEntries);
      moddedMultiplicities = new Array<i32>(numEntries);

      moddedConditions[0] = modConditionId;
      moddedIndexSets[0] = modIndexSet;
      moddedMultiplicities[0] = modDirection;
      for (let i = 1; i < numEntries; i++) {
        moddedConditions[i] = conditions[i - 1];
        moddedIndexSets[i] = indexSets[i - 1];
        moddedMultiplicities[i] = multiplicities[i - 1];
      }
    } else {
      let multiplicity = multiplicities[collectionIndex];
      if (multiplicity + modDirection == 0) {
        let numEntries = conditions.length - 1;
        moddedConditions = new Array<string>(numEntries);
        moddedIndexSets = new Array<BigInt>(numEntries);
        moddedMultiplicities = new Array<i32>(numEntries);
        for(let i = 0; i < collectionIndex; i++) {
          moddedConditions[i] = conditions[i];
          moddedIndexSets[i] = indexSets[i];
          moddedMultiplicities[i] = multiplicities[i];
        }
        for(let i = collectionIndex; i < numEntries; i++) {
          moddedConditions[i] = conditions[i + 1];
          moddedIndexSets[i] = indexSets[i + 1];
          moddedMultiplicities[i] = multiplicities[i + 1];
        }
      } else {
        let numEntries = conditions.length;
        moddedConditions = conditions;
        moddedIndexSets = indexSets;
        moddedMultiplicities = new Array<i32>(numEntries);
        for (let i = 0; i < numEntries; i++) {
          if (i == collectionIndex) {
            moddedMultiplicities[i] = multiplicity + modDirection;
          } else {
            moddedMultiplicities[i] = multiplicity;
          }
        }
      }
    }

    return new CollectionInfo(moddedConditions, moddedIndexSets, moddedMultiplicities);
  }
}

function operateOnSubtree(
  operation: SubtreeOperation,
  blockTimestamp: BigInt,
  conditionalTokens: ConditionalTokens,
  user: Address,
  collateralToken: Address,
  parentCollectionId: Bytes,
  conditionId: Bytes,
  indexSets: BigInt[],
  amount: BigInt,
): void {
  let global = requireGlobal();
  let conditionIdHex = conditionId.toHex();
  let condition = Condition.load(conditionIdHex);

  touchUser(user, blockTimestamp);

  let parentCollectionInfo: CollectionInfo;

  let jointCollectionId: Bytes;
  let jointCollectionInfo: CollectionInfo;
  
  let unionIndexSet = sum(indexSets);
  let changesDepth = operation === SubtreeOperation.Redeem || isFullIndexSet(unionIndexSet, condition.outcomeSlotCount);
  let rootBranch = isZeroCollectionId(parentCollectionId);
  
  if (changesDepth) {
    if (rootBranch) {
      parentCollectionInfo = new CollectionInfo([], [], []);
    } else {
      let parentCollection = Collection.load(parentCollectionId.toHex());
      if (parentCollection == null) {
        if (operation === SubtreeOperation.Split) {
          log.error("expected parent collection {} to exist", [parentCollectionId.toHex()]);
        }

        for (let i = 0; i < indexSets.length; i++) {
          let indexSet = indexSets[i];
          let childCollectionId = conditionalTokens.getCollectionId(
            parentCollectionId,
            conditionId,
            indexSet,
          );
          let childCollection = Collection.load(childCollectionId.toHex());

          if (childCollection != null) {
            let childCollectionInfo = new CollectionInfo(
              childCollection.conditions,
              childCollection.indexSets,
              childCollection.multiplicities,
            );
            parentCollectionInfo = childCollectionInfo.mod(
              conditionIdHex, indexSet, -1,
            );
    
            parentCollection = new Collection(parentCollectionId.toHex());
            let conditionIds = parentCollectionInfo.conditions;
            parentCollection.conditions = conditionIds;
            parentCollection.conditionIds = conditionIds;
            parentCollection.conditionIdsStr = conditionIds.join('');
            parentCollection.indexSets = parentCollectionInfo.indexSets;
            parentCollection.multiplicities = parentCollectionInfo.multiplicities;
    
            parentCollection.save();
            global.numCollections += 1;
            break;
          }
        }
        if (parentCollection == null) {
          log.error('could not determine parent collection from one of children', []);
          return;
        }
      } else {
        parentCollectionInfo = new CollectionInfo(
          parentCollection.conditions,
          parentCollection.indexSets,
          parentCollection.multiplicities,
        );
      }
    }

    jointCollectionId = parentCollectionId;
    jointCollectionInfo = parentCollectionInfo;
  } else {
    jointCollectionId = conditionalTokens.getCollectionId(
      parentCollectionId,
      conditionId,
      unionIndexSet
    );
    let unionCollection = Collection.load(jointCollectionId.toHex());
    if (unionCollection == null) {
      if (operation === SubtreeOperation.Split) {
        log.error("expected union collection {} to exist", [jointCollectionId.toHex()]);
      }

      for (let i = 0; i < indexSets.length; i++) {
        let indexSet = indexSets[i];
        let childCollectionId = conditionalTokens.getCollectionId(
          parentCollectionId,
          conditionId,
          indexSet,
        );
        let childCollection = Collection.load(childCollectionId.toHex());

        if (childCollection != null) {
          let childCollectionInfo = new CollectionInfo(
            childCollection.conditions,
            childCollection.indexSets,
            childCollection.multiplicities,
          );
          jointCollectionInfo = childCollectionInfo.mod(
            conditionIdHex,
            indexSet,
            -1,
          ).mod(
            conditionIdHex,
            unionIndexSet,
            1,
          );
  
          unionCollection = new Collection(jointCollectionId.toHex());
          let conditionIds = jointCollectionInfo.conditions
          unionCollection.conditions = conditionIds;
          unionCollection.conditionIds = conditionIds;
          unionCollection.conditionIdsStr = conditionIds.join('');
          unionCollection.indexSets = jointCollectionInfo.indexSets;
          unionCollection.multiplicities = jointCollectionInfo.multiplicities;
    
          unionCollection.save();
          global.numCollections += 1;
          break;
        }
      }

      if (unionCollection == null) {
        log.error('could not determine union collection from one of children', []);
        return;
      }
  } else {
      jointCollectionInfo = new CollectionInfo(
        unionCollection.conditions,
        unionCollection.indexSets,
        unionCollection.multiplicities,
      )
    }

    parentCollectionInfo = jointCollectionInfo.mod(
      conditionIdHex,
      unionIndexSet,
      -1,
    );
  }

  for (let i = 0; i < indexSets.length; i++) {
    let indexSet = indexSets[i];
    let collectionId = conditionalTokens.getCollectionId(
      parentCollectionId,
      conditionId,
      indexSet,
    );
    let collection = Collection.load(collectionId.toHex());
    if (collection == null) {
      if (operation === SubtreeOperation.Merge) {
        log.error("expected child collection {} to exist", [collectionId.toHex()]);
      }
      let collectionInfo = parentCollectionInfo.mod(
        conditionIdHex,
        indexSet,
        1,
      );
      collection = new Collection(collectionId.toHex());
      let conditionIds = collectionInfo.conditions
      collection.conditions = conditionIds;
      collection.conditionIds = conditionIds;
      collection.conditionIdsStr = conditionIds.join('');
      collection.indexSets = collectionInfo.indexSets;
      collection.multiplicities = collectionInfo.multiplicities;
      collection.save();
      global.numCollections += 1;
    }

    let positionId = toPositionId(collateralToken, collectionId);
    let positionIdHex = positionId.toHex();

    let position = Position.load(positionId.toHex());
    if (position == null) {
      if (operation === SubtreeOperation.Merge) {
        log.error("expected child position {} to exist", [positionIdHex]);
      }

      position = new Position(positionIdHex);
      position.positionId = positionIdHex;
      let collateralTokenAddress = collateralToken.toHex();
      position.collateralToken = collateralTokenAddress;
      position.collateralTokenAddress = collateralTokenAddress;
      position.collection = collection.id;

      let conditionIds = collection.conditions;
      position.conditions = conditionIds;
      position.conditionIds = conditionIds;
      position.conditionIdsStr = conditionIds.join('');
      position.indexSets = collection.indexSets;
      position.multiplicities = collection.multiplicities;

      position.activeValue = zeroAsBigInt;
      position.lifetimeValue = zeroAsBigInt;
      position.createTimestamp = blockTimestamp;

      global.numPositions += 1;
    }

    let zeroUserPositionId = concat(zeroAddress, positionId);
    let zeroUserPosition = UserPosition.load(zeroUserPositionId.toHex());

    if (zeroUserPosition != null) {
      position.activeValue = zeroUserPosition.balance.neg();
    } else if (operation === SubtreeOperation.Merge) {
      log.error('could not retrieve zeroUserPosition for position {}', [
        position.id
      ]);
    }

    if (position.activeValue.gt(position.lifetimeValue)) {
      position.lifetimeValue = position.activeValue;
    }

    position.save();
  }

  if(changesDepth && rootBranch) {
    let collateral = CollateralToken.load(collateralToken.toHex());
    if (collateral == null) {
      if (operation !== SubtreeOperation.Split) {
        log.error("expected collateral {} to exist", [collateralToken.toHex()]);
      }
  
      collateral = new CollateralToken(collateralToken.toHex());
      collateral.activeAmount = zeroAsBigInt;
      collateral.splitAmount = zeroAsBigInt;
      collateral.mergedAmount = zeroAsBigInt;
      collateral.redeemedAmount = zeroAsBigInt;
    }
    switch (operation) {
      case SubtreeOperation.Split:
        collateral.activeAmount = collateral.activeAmount.plus(amount);
        collateral.splitAmount = collateral.splitAmount.plus(amount);
        break;
      case SubtreeOperation.Merge:
        collateral.activeAmount = collateral.activeAmount.minus(amount);
        collateral.mergedAmount = collateral.mergedAmount.plus(amount);
        break;
      case SubtreeOperation.Redeem:
        collateral.activeAmount = collateral.activeAmount.minus(amount);
        collateral.redeemedAmount = collateral.redeemedAmount.plus(amount);
        break;
    }

    collateral.save();
  } else {
    let jointPositionId = toPositionId(collateralToken, jointCollectionId);
    let jointPositionIdHex = jointPositionId.toHex()
    let jointPosition = Position.load(jointPositionIdHex);
    if (jointPosition == null) {
      if (operation === SubtreeOperation.Split) {
        log.error("expected joint position {} to exist", [jointPositionIdHex]);
      }

      jointPosition = new Position(jointPositionIdHex);
      jointPosition.positionId = jointPositionIdHex;
      let collateralTokenAddress = collateralToken.toHex();
      jointPosition.collateralToken = collateralTokenAddress;
      jointPosition.collateralTokenAddress = collateralTokenAddress;
      jointPosition.collection = jointCollectionId.toHex();
      let conditionIds = jointCollectionInfo.conditions
      jointPosition.conditions = conditionIds;
      jointPosition.conditionIds = conditionIds;
      jointPosition.conditionIdsStr = conditionIds.join('')
      jointPosition.indexSets = jointCollectionInfo.indexSets;
      jointPosition.multiplicities = jointCollectionInfo.multiplicities;
      jointPosition.lifetimeValue = zeroAsBigInt;
      jointPosition.activeValue = zeroAsBigInt;
      jointPosition.createTimestamp = blockTimestamp;

      global.numPositions += 1;
    }

    switch (operation) {
      case SubtreeOperation.Split:
        jointPosition.activeValue = jointPosition.activeValue.minus(amount);
        break;
      case SubtreeOperation.Merge:
      case SubtreeOperation.Redeem:
        jointPosition.activeValue = jointPosition.activeValue.plus(amount);
        break;
    }

    if (jointPosition.activeValue.gt(jointPosition.lifetimeValue)) {
      jointPosition.lifetimeValue = jointPosition.activeValue;
    }

    jointPosition.save();
  }

  global.save();
}

export function handlePositionSplit(event: PositionSplit): void {
  let params = event.params;

  operateOnSubtree(
    SubtreeOperation.Split,
    event.block.timestamp,
    ConditionalTokens.bind(event.address),
    params.stakeholder,
    params.collateralToken,
    params.parentCollectionId,
    params.conditionId,
    params.partition,
    params.amount,
  );
}

export function handlePositionsMerge(event: PositionsMerge): void {
  let params = event.params;

  operateOnSubtree(
    SubtreeOperation.Merge,
    event.block.timestamp,
    ConditionalTokens.bind(event.address),
    params.stakeholder,
    params.collateralToken,
    params.parentCollectionId,
    params.conditionId,
    params.partition,
    params.amount,
  );
}

export function handlePayoutRedemption(event: PayoutRedemption): void {
  let params = event.params;

  operateOnSubtree(
    SubtreeOperation.Redeem,
    event.block.timestamp,
    ConditionalTokens.bind(event.address),
    params.redeemer,
    params.collateralToken,
    params.parentCollectionId,
    params.conditionId,
    params.indexSets,
    params.payout,
  );
}
