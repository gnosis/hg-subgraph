import { crypto, log, Address, BigInt, Bytes } from '@graphprotocol/graph-ts';
import {
  PositionSplit,
  PositionsMerge,
  PayoutRedemption,
  ConditionalTokens
} from '../generated/ConditionalTokens/ConditionalTokens';

import { Condition, User, Collateral, Collection, Position, UserPosition } from '../generated/schema';

import { sum, zeroAsBigInt, concat, checkIfValueExistsInArray } from './utils';

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

function operateOnSubtree(
  operation: SubtreeOperation,
  blockTimestamp: BigInt,
  conditionalTokens: ConditionalTokens,
  stakeholder: Address,
  collateralToken: Address,
  parentCollectionId: Bytes,
  conditionId: Bytes,
  partition: BigInt[],
  amount: BigInt,
): void {
  let conditionIdHex = conditionId.toHex();
  let condition = Condition.load(conditionIdHex);

  let user = User.load(stakeholder.toHex());
  if (user == null) {
    user = new User(stakeholder.toHex());
    user.firstParticipation = blockTimestamp;
    user.participatedConditions = [];
  }

  if (!checkIfValueExistsInArray(user.participatedConditions, conditionIdHex)) {
    let userParticipatedConditions = user.participatedConditions;
    userParticipatedConditions.push(conditionIdHex);
    user.participatedConditions = userParticipatedConditions;
  }

  user.lastActive = blockTimestamp;
  user.save();

  let parentConditions: string[];
  let parentIndexSets: BigInt[];
  
  let unionIndexSet = sum(partition);
  let changesDepth = operation === SubtreeOperation.Redeem || isFullIndexSet(unionIndexSet, condition.outcomeSlotCount);
  let rootBranch = isZeroCollectionId(parentCollectionId);
  
  if (changesDepth) {
    if (rootBranch) {
      parentConditions = [];
      parentIndexSets = [];
    } else {
      let parentCollection = Collection.load(parentCollectionId.toHex());
      if (parentCollection == null) {
        if (operation === SubtreeOperation.Split) {
          log.error("expected parent collection {} to exist", [parentCollectionId.toHex()]);
        }
        log.error("not implemented yet", []);
        parentCollection = new Collection(parentCollectionId.toHex());
        parentCollection.conditions = [];
        parentCollection.indexSets = [];
      }
      parentConditions = parentCollection.conditions;
      parentIndexSets = parentCollection.indexSets;
    }
  } else {
    let unionCollectionId = conditionalTokens.getCollectionId(
      parentCollectionId,
      conditionId,
      unionIndexSet
    );
    let unionCollection = Collection.load(unionCollectionId.toHex());
    if (unionCollection == null) {
      if (operation === SubtreeOperation.Split) {
        log.error("expected union collection {} to exist", [unionCollectionId.toHex()]);
      }
      log.error("not implemented yet", []);
      // dif: merge can result in a new position/collection
      unionCollection = new Collection(unionCollectionId.toHex());
      unionCollection.conditions = ["ERROR"];
      unionCollection.indexSets = [BigInt.fromI32(-1)];
    }
    let parentCollectionConditions = unionCollection.conditions;
    let parentCollectionIndexSets = unionCollection.indexSets;
    parentConditions = new Array<string>(unionCollection.conditions.length - 1);
    parentIndexSets = new Array<BigInt>(unionCollection.indexSets.length - 1);

    for (let i = 0, j = 0; i < unionCollection.conditions.length; i++) {
      if (parentCollectionConditions[i] != conditionIdHex) {
        parentConditions[j] = parentCollectionConditions[i];
        parentIndexSets[j] = parentCollectionIndexSets[i];
        j++;
      }
    }
  }

  for (let i = 0; i < partition.length; i++) {
    let indexSet = partition[i];
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
      collection = new Collection(collectionId.toHex());
      let conditions = new Array<string>(parentConditions.length + 1);
      let indexSets = new Array<BigInt>(parentIndexSets.length + 1);
      for (let j = 0; j < parentConditions.length; j++) {
        conditions[j] = parentConditions[j];
        indexSets[j] = parentIndexSets[j];
      }
      conditions[parentConditions.length] = conditionIdHex;
      indexSets[parentIndexSets.length] = indexSet;
      collection.conditions = conditions;
      collection.indexSets = indexSets;
      collection.save();
    }

    let positionId = toPositionId(collateralToken, collectionId);

    // Position Section
    let position = Position.load(positionId.toHex());
    if (position == null) {
      if (operation === SubtreeOperation.Merge) {
        log.error("expected child position {} to exist", [positionId.toHex()]);
      }

      position = new Position(positionId.toHex());
      position.collateralToken = collateralToken;
      position.collection = collection.id;

      let conditions = collection.conditions;
      let indexSets = collection.indexSets;
      position.conditions = conditions;
      position.indexSets = indexSets;

      position.activeValue = zeroAsBigInt;
      position.lifetimeValue = zeroAsBigInt;
    }

    // UserPosition Section
    let userPositionId = concat(stakeholder, positionId);
    let userPosition = UserPosition.load(userPositionId.toHex());

    if (userPosition == null) {
      userPosition = new UserPosition(userPositionId.toHex());
      userPosition.balance = zeroAsBigInt;
      userPosition.user = user.id;
      userPosition.position = position.id;
    }

    switch (operation) {
      case SubtreeOperation.Split:
        position.activeValue = position.activeValue.plus(amount);
        position.lifetimeValue = position.lifetimeValue.plus(amount);
        userPosition.balance = userPosition.balance.plus(amount);
        break;
      case SubtreeOperation.Merge:
        position.activeValue = position.activeValue.minus(amount);
        userPosition.balance = userPosition.balance.minus(amount);
        break;
      case SubtreeOperation.Redeem:
        position.activeValue = position.activeValue.minus(userPosition.balance);
        userPosition.balance = zeroAsBigInt;
        break;
    }

    position.save();
    userPosition.save();
  }

  if(changesDepth && rootBranch) {
    let collateral = Collateral.load(collateralToken.toHex());
    if (collateral == null) {
      if (operation === SubtreeOperation.Merge) {
        log.error("expected collateral {} to exist", [collateralToken.toHex()]);
      }
  
      collateral = new Collateral(collateralToken.toHex());
      collateral.splitCollateral = zeroAsBigInt;
      collateral.redeemedCollateral = zeroAsBigInt;
    }
    // dif: splitCollateral vs redeemedCollateral(?)
    switch (operation) {
      case SubtreeOperation.Split:
        collateral.splitCollateral = collateral.splitCollateral.plus(amount);
        break;
      case SubtreeOperation.Merge:
        collateral.redeemedCollateral = collateral.redeemedCollateral.plus(amount);
        break;
      case SubtreeOperation.Redeem:
        collateral.redeemedCollateral = collateral.redeemedCollateral.plus(amount);
        break;
    }

    collateral.save();
  } else {
    let unionCollectionId = changesDepth ? parentCollectionId :
      conditionalTokens.getCollectionId(
        parentCollectionId,
        conditionId,
        unionIndexSet,
      );

    let unionPositionId = toPositionId(collateralToken, unionCollectionId);
    let unionPosition = Position.load(unionPositionId.toHex());
    if (unionPosition == null) {
      log.error("expected parent position {} to exist", [unionPositionId.toHex()]);
      // dif: merge can result in a new position/collection
      unionPosition = new Position(unionPositionId.toHex());
      unionPosition.collateralToken = collateralToken;
      unionPosition.collection = parentCollectionId.toHex();
      unionPosition.conditions = parentConditions;
      unionPosition.indexSets = parentIndexSets;
      unionPosition.lifetimeValue = zeroAsBigInt;
      unionPosition.activeValue = zeroAsBigInt;
    }

    switch (operation) {
      case SubtreeOperation.Split:
        unionPosition.activeValue = unionPosition.activeValue.minus(amount);
        break;
      case SubtreeOperation.Merge:
        unionPosition.activeValue = unionPosition.activeValue.plus(amount);
        break;
      case SubtreeOperation.Redeem:
        unionPosition.activeValue = unionPosition.activeValue.plus(amount);
        break;
    }

    unionPosition.save();
  
    let userUnionPositionId = concat(stakeholder, unionPositionId);
    let userUnionPosition = UserPosition.load(userUnionPositionId.toHex());
    if (userUnionPosition == null) {
      log.error("expected parent position {} of user {} to exist", [
        unionPositionId.toHex(),
        stakeholder.toHex(),
      ]);
      userUnionPosition = new UserPosition(userUnionPositionId.toHex());
      userUnionPosition.user = user.id;
      userUnionPosition.position = unionPosition.id;
      userUnionPosition.balance = zeroAsBigInt;
    }

    switch (operation) {
      case SubtreeOperation.Split:
        userUnionPosition.balance = userUnionPosition.balance.minus(amount);
        break;
      case SubtreeOperation.Merge:
        userUnionPosition.balance = userUnionPosition.balance.plus(amount);
        break;
      case SubtreeOperation.Redeem:
        userUnionPosition.balance = userUnionPosition.balance.plus(amount);
        break;
    }
    userUnionPosition.save();
  }
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
  let conditionalTokens = ConditionalTokens.bind(event.address);

  let params = event.params;
  let indexSets = params.indexSets;
  let conditionId = params.conditionId.toHex();
  let condition = Condition.load(conditionId);

  // User Section
  let user = User.load(params.redeemer.toHex());
  if (user == null) {
    user = new User(params.redeemer.toHex());
    user.firstParticipation = event.block.timestamp;
    user.participatedConditions = [];
  }

  if (!checkIfValueExistsInArray(user.participatedConditions, conditionId)) {
    let userParticipatedConditions = user.participatedConditions;
    userParticipatedConditions.push(conditionId);
    user.participatedConditions = userParticipatedConditions;
  }

  user.lastActive = event.block.timestamp;
  user.save();

  let redeemingToRoot = isZeroCollectionId(params.parentCollectionId)

  let parentCollectionId = params.parentCollectionId;

  for (var i = 0; i < indexSets.length; i++) {
    let collectionId = conditionalTokens.getCollectionId(
      parentCollectionId,
      params.conditionId,
      indexSets[i],
    );
    let positionId = toPositionId(params.collateralToken, collectionId);
    let position = Position.load(positionId.toHex());

    let userPositionId = concat(params.redeemer, positionId);
    let userPosition = UserPosition.load(userPositionId.toHex());

    if (userPosition == null) {
      userPosition = new UserPosition(userPositionId.toHex());
      userPosition.position = position.id;
      userPosition.user = user.id;
      userPosition.balance = zeroAsBigInt;
    }

    position.activeValue = position.activeValue.minus(userPosition.balance);
    position.save();
    userPosition.balance = zeroAsBigInt;
    userPosition.save();
  }

  if (redeemingToRoot) {
    // Collateral Section
    let collateralToken = Collateral.load(params.collateralToken.toHex());
    collateralToken.redeemedCollateral = collateralToken.redeemedCollateral.plus(params.payout);
    collateralToken.save();
  } else {
    let parentPositionId = toPositionId(params.collateralToken, parentCollectionId);
    let parentPosition = Position.load(parentPositionId.toHex());
    parentPosition.activeValue = parentPosition.activeValue.plus(params.payout);
    parentPosition.save();

    // Parent UserPosition Section
    let parentPositionUserPositionId = concat(params.redeemer, parentPositionId);
    let parentPositionUserPosition = UserPosition.load(parentPositionUserPositionId.toHex());
    if (parentPositionUserPosition == null) {
      parentPositionUserPosition = new UserPosition(parentPositionUserPositionId.toHex());
      parentPositionUserPosition.position = parentPosition.id;
      parentPositionUserPosition.user = user.id;
      parentPositionUserPosition.balance = zeroAsBigInt;
    }
    parentPositionUserPosition.balance = parentPositionUserPosition.balance.plus(params.payout);
    parentPositionUserPosition.save();
  }
}
