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

export function handlePositionSplit(event: PositionSplit): void {
  let conditionalTokens = ConditionalTokens.bind(event.address);

  let params = event.params;
  let partition = params.partition;
  let conditionId = params.conditionId.toHex();
  let condition = Condition.load(conditionId);

  // Create or update the User in the system
  let user = User.load(params.stakeholder.toHex());
  if (user == null) {
    user = new User(params.stakeholder.toHex());
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

  let parentIndexSet = sum(partition);
  let parentConditions: string[];
  let parentIndexSets: BigInt[];

  let completelySplitsCondition = isFullIndexSet(parentIndexSet, condition.outcomeSlotCount);
  let splittingFromRoot = isZeroCollectionId(params.parentCollectionId);
  
  if (completelySplitsCondition) {
    if (splittingFromRoot) {
      let collateralToken = Collateral.load(params.collateralToken.toHex());
      if (collateralToken == null) {
        // dif: merge errors on nonexistence
        collateralToken = new Collateral(params.collateralToken.toHex());
        collateralToken.splitCollateral = zeroAsBigInt;
        collateralToken.redeemedCollateral = zeroAsBigInt;
      }
      // dif: splitCollateral vs redeemedCollateral(?)
      collateralToken.splitCollateral = collateralToken.splitCollateral.plus(params.amount);
      collateralToken.save();

      parentConditions = [];
      parentIndexSets = [];
    } else {
      let parentCollection = Collection.load(params.parentCollectionId.toHex());
      if (parentCollection == null) {
        log.error("expected collection {} to exist", [params.parentCollectionId.toHex()]);
        // dif: merge should construct parent collection here
      }
      parentConditions = parentCollection.conditions;
      parentIndexSets = parentCollection.indexSets;
    }
  } else {
    let collectionId = conditionalTokens.getCollectionId(
      params.parentCollectionId,
      params.conditionId,
      parentIndexSet
    );
    let parentCollection = Collection.load(collectionId.toHex());
    if (parentCollection == null) {
      log.error("expected collection {} to exist", [collectionId.toHex()]);
      // dif: merge can result in a new position/collection
    }
    let parentCollectionConditions = parentCollection.conditions;
    let parentCollectionIndexSets = parentCollection.indexSets;
    parentConditions = new Array<string>(parentCollection.conditions.length - 1);
    parentIndexSets = new Array<BigInt>(parentCollection.indexSets.length - 1);

    for (let i = 0, j = 0; i < parentCollection.conditions.length; i++) {
      if (parentCollectionConditions[i] != conditionId) {
        parentConditions[j] = parentCollectionConditions[i];
        parentIndexSets[j] = parentCollectionIndexSets[i];
        j++;
      }
    }
  }

  for (let i = 0; i < partition.length; i++) {
    let indexSet = partition[i];
    let collectionId = conditionalTokens.getCollectionId(
      params.parentCollectionId,
      params.conditionId,
      indexSet,
    );
    let collection = Collection.load(collectionId.toHex());
    if (collection == null) {
      // dif: error for merge as this should exist already
      collection = new Collection(collectionId.toHex());
      let conditions = new Array<string>(parentConditions.length + 1);
      let indexSets = new Array<BigInt>(parentIndexSets.length + 1);
      for (let j = 0; j < parentConditions.length; j++) {
        conditions[j] = parentConditions[j];
        indexSets[j] = parentIndexSets[j];
      }
      conditions[parentConditions.length] = conditionId;
      indexSets[parentIndexSets.length] = indexSet;
      collection.conditions = conditions;
      collection.indexSets = indexSets;
      collection.save();
    }

    // Position Section
    let positionId = toPositionId(params.collateralToken, collectionId);
    let position = Position.load(positionId.toHex());
    if (position == null) {
      // dif: error for merge as this should exist already
      position = new Position(positionId.toHex());
      position.collateralToken = params.collateralToken;
      position.collection = collection.id;

      let conditions = collection.conditions;
      let indexSets = collection.indexSets;
      position.conditions = conditions;
      position.indexSets = indexSets;

      position.activeValue = zeroAsBigInt;
      position.lifetimeValue = zeroAsBigInt;
    }
    // dif: minus for merge
    position.activeValue = position.activeValue.plus(params.amount);
    // dif: noop for merge
    position.lifetimeValue = position.lifetimeValue.plus(params.amount);
    position.save();

    // UserPosition Section
    let userPositionId = concat(params.stakeholder, positionId);
    let userPosition = UserPosition.load(userPositionId.toHex());

    if (userPosition == null) {
      userPosition = new UserPosition(userPositionId.toHex());
      userPosition.balance = zeroAsBigInt;
      userPosition.user = user.id;
      userPosition.position = position.id;
    }
    // dif: minus for merge
    userPosition.balance = userPosition.balance.plus(params.amount);
    userPosition.save();
  }

  if (!completelySplitsCondition || !splittingFromRoot) {
    let parentCollectionId = completelySplitsCondition ? params.parentCollectionId :
      conditionalTokens.getCollectionId(
        params.parentCollectionId,
        params.conditionId,
        parentIndexSet,
      );

    let parentPositionId = toPositionId(params.collateralToken, parentCollectionId);
    let parentPosition = Position.load(parentPositionId.toHex());
    if (parentPosition == null) {
      log.error("expected parent position {} to exist", [parentPositionId.toHex()]);
      // dif: merge can result in a new position/collection
    }
    // dif: plus in merge
    parentPosition.activeValue = parentPosition.activeValue.minus(params.amount);
    parentPosition.save();
  
    let userParentPositionId = concat(params.stakeholder, parentPositionId);
    let userParentPosition = UserPosition.load(userParentPositionId.toHex());
    if (userParentPosition == null) {
      log.error("expected parent position {} of user {} to exist", [
        parentPositionId.toHex(),
        params.stakeholder.toHex(),
      ]);
      // dif: merge can result in a new user position/collection
    }
    // dif: plus in merge
    userParentPosition.balance = userParentPosition.balance.minus(params.amount);
    userParentPosition.save();
  }
}

export function handlePositionsMerge(event: PositionsMerge): void {
  let conditionalTokens = ConditionalTokens.bind(event.address);

  let params = event.params;
  let partition = params.partition;
  let conditionId = params.conditionId.toHex();
  let condition = Condition.load(conditionId);

  // User Section
  let user = User.load(params.stakeholder.toHex());
  if (user == null) {
    user = new User(params.stakeholder.toHex());
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

  let parentIndexSet = sum(partition);
  let parentConditions: string[];
  let parentIndexSets: BigInt[];


  let completelyMergesCondition = isFullIndexSet(parentIndexSet, condition.outcomeSlotCount);
  let mergingToRoot = isZeroCollectionId(params.parentCollectionId);

  if (completelyMergesCondition) {
    if (mergingToRoot) {
      let collateralToken = Collateral.load(params.collateralToken.toHex());
      collateralToken.redeemedCollateral = collateralToken.redeemedCollateral.plus(params.amount);
      collateralToken.save();

      parentConditions = [];
      parentIndexSets = [];
    } else {
      // completelyMergesCondition && !mergingFromRoot
      let parentCollection = Collection.load(params.parentCollectionId.toHex());
      if (parentCollection == null) {
        log.error("not implemented yet", []);
        // dif: merge should construct parent collection here
        parentCollection = new Collection(params.parentCollectionId.toHex());
        parentCollection.conditions = [];
        parentCollection.indexSets = [];
      }
      parentConditions = parentCollection.conditions;
      parentIndexSets = parentCollection.indexSets;
    }
  } else {
    let collectionId = conditionalTokens.getCollectionId(
      params.parentCollectionId,
      params.conditionId,
      parentIndexSet
    );
    let parentCollection = Collection.load(collectionId.toHex());
    if (parentCollection == null) {
      log.error("not implemented yet", []);
      // dif: merge can result in a new position/collection
      parentCollection = new Collection(collectionId.toHex());
      parentCollection.conditions = ["foo"];
      parentCollection.indexSets = [BigInt.fromI32(-1)];
    }
    let parentCollectionConditions = parentCollection.conditions;
    let parentCollectionIndexSets = parentCollection.indexSets;
    parentConditions = new Array<string>(parentCollection.conditions.length - 1);
    parentIndexSets = new Array<BigInt>(parentCollection.indexSets.length - 1);

    for (let i = 0, j = 0; i < parentCollection.conditions.length; i++) {
      if (parentCollectionConditions[i] != conditionId) {
        parentConditions[j] = parentCollectionConditions[i];
        parentIndexSets[j] = parentCollectionIndexSets[i];
        j++;
      }
    }
  }

  for (let i = 0; i < partition.length; i++) {
    let collectionId = conditionalTokens.getCollectionId(
      params.parentCollectionId,
      params.conditionId,
      partition[i],
    );
    // Position Section
    let positionId = toPositionId(params.collateralToken, collectionId);
    let position = Position.load(positionId.toHex());
    position.activeValue = position.activeValue.minus(params.amount);
    position.save();

    // UserPosition Section
    let userPositionId = concat(params.stakeholder, positionId);
    let userPosition = UserPosition.load(userPositionId.toHex());

    if (userPosition == null) {
      userPosition = new UserPosition(userPositionId.toHex());
      userPosition.balance = zeroAsBigInt;
      userPosition.user = user.id;
      userPosition.position = position.id;
    }
    userPosition.balance = userPosition.balance.minus(params.amount);
    userPosition.save();
  }

  if (!completelyMergesCondition || !mergingToRoot) {
    let parentCollectionId = completelyMergesCondition ? params.parentCollectionId :
      conditionalTokens.getCollectionId(
        params.parentCollectionId,
        params.conditionId,
        parentIndexSet,
      );

    let parentPositionId = toPositionId(params.collateralToken, parentCollectionId);
    let parentPosition = Position.load(parentPositionId.toHex());
    if (parentPosition == null) {
      // Collection Section

      // Load the parent positions Conditions and Collections
      let parentCollection = Collection.load(params.parentCollectionId.toHex());
      let parentCollectionConditionsList = parentCollection.conditions;
      let parentCollectionIndexSetsList = parentCollection.indexSets;
      let totalIndexSetCollectionConditions = new Array<string>(
        parentCollection.conditions.length + 1
      );
      let totalIndexSetCollectionIndexSets = new Array<BigInt>(
        parentCollection.conditions.length + 1
      );
      for (var m = 0; m < parentCollection.conditions.length; m++) {
        totalIndexSetCollectionConditions[m] = parentCollectionConditionsList[m];
        totalIndexSetCollectionIndexSets[m] = parentCollectionIndexSetsList[m];
      }
      totalIndexSetCollectionConditions[
        totalIndexSetCollectionConditions.length
      ] = params.conditionId.toHex();
      totalIndexSetCollectionIndexSets[totalIndexSetCollectionConditions.length] = parentIndexSet;

      let totalIndexSetCollection = Collection.load(parentCollectionId.toHex());
      if (totalIndexSetCollection == null) {
        totalIndexSetCollection = new Collection(parentCollectionId.toHex());
        totalIndexSetCollection.conditions = totalIndexSetCollectionConditions;
        totalIndexSetCollection.indexSets = totalIndexSetCollectionIndexSets;
        totalIndexSetCollection.save();
      }
      // Position Section
      parentPosition = new Position(parentPositionId.toHex());
      parentPosition.collateralToken = params.collateralToken;
      parentPosition.collection = totalIndexSetCollection.id;
      parentPosition.conditions = totalIndexSetCollectionConditions;
      parentPosition.indexSets = totalIndexSetCollectionIndexSets;
      parentPosition.lifetimeValue = zeroAsBigInt;
      parentPosition.activeValue = zeroAsBigInt;
    }
    parentPosition.activeValue = parentPosition.activeValue.plus(params.amount);

    parentPosition.save();

    // Union UserPosition Section
    let userParentPositionId = concat(params.stakeholder, parentPositionId);
    let userParentPosition = UserPosition.load(userParentPositionId.toHex());
    if (userParentPosition == null) {
      userParentPosition = new UserPosition(userParentPositionId.toHex());
      userParentPosition.user = user.id;
      userParentPosition.position = parentPosition.id;
      userParentPosition.balance = zeroAsBigInt;
    }
    userParentPosition.balance = userParentPosition.balance.plus(params.amount);
    userParentPosition.save();
  }
}

export function handlePayoutRedemption(event: PayoutRedemption): void {
  let params = event.params;
  let indexSets = params.indexSets;

  // User Section
  let user = User.load(params.redeemer.toHex());
  if (user == null) {
    user = new User(params.redeemer.toHex());
    user.firstParticipation = event.block.timestamp;
    user.participatedConditions = [];
  }
  user.lastActive = event.block.timestamp;
  user.save();

  // If the parentCollection is Zero, then we redeem into Collateral -- else we redeem into the ParentCollection
  if (isZeroCollectionId(params.parentCollectionId)) {
    // Collateral Section
    let collateralToken = Collateral.load(params.collateralToken.toHex());
    collateralToken.redeemedCollateral = collateralToken.redeemedCollateral.plus(params.payout);
    collateralToken.save();
  } else {
    // add params.totalPayout to the parentCollectionId if there is one

    // Parent Position Section
    let parentPositionId = toPositionId(params.collateralToken, params.parentCollectionId);
    let parentPosition = Position.load(parentPositionId.toHex());
    parentPosition.activeValue = parentPosition.activeValue.plus(params.payout);
    parentPosition.save();
    // Parent UserPosition Section
    let parentPositionUserPositionId = concat(params.redeemer, parentPositionId) as Bytes;
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
  // put all the UserPositions from the indexSet list to 0 -- make sure position.activeValue can be subtracted by the balance before this happens
  let conditionalTokens = ConditionalTokens.bind(event.address);
  for (var i = 0; i < indexSets.length; i++) {
    let collectionId = conditionalTokens.getCollectionId(
      params.parentCollectionId,
      params.conditionId,
      indexSets[i],
    );
    let positionId = toPositionId(params.collateralToken, collectionId);
    let userPositionId = concat(params.redeemer, positionId) as Bytes;
    let position = Position.load(positionId.toHex());
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
}
