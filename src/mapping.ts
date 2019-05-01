import { crypto, Address, BigInt, Bytes, TypedMap, ByteArray } from '@graphprotocol/graph-ts';
import {
  ConditionPreparation,
  ConditionResolution,
  PositionSplit,
  PositionsMerge,
  PredictionMarketSystem,
  PayoutRedemption,
  TransferSingle,
  TransferBatch
} from './types/PredictionMarketSystem/PredictionMarketSystem';
import {
  Condition,
  Collection,
  Position,
  User,
  UserPosition,
  Collateral,
  Operator
} from './types/schema';

let zeroAsBigInt: BigInt = BigInt.fromI32(0);

export function handleConditionPreparation(event: ConditionPreparation): void {
  let condition = new Condition(event.params.conditionId.toHex());
  condition.creator = event.transaction.from;
  condition.oracle = event.params.oracle;
  condition.questionId = event.params.questionId;
  condition.outcomeSlotCount = event.params.outcomeSlotCount.toI32();
  condition.resolved = false;
  condition.createTransaction = event.transaction.hash;
  condition.creationTimestamp = event.block.timestamp;
  condition.blockNumber = event.block.number;
  condition.save();
}

export function handleConditionResolution(event: ConditionResolution): void {
  let condition = Condition.load(event.params.conditionId.toHex());
  condition.payoutNumerators = event.params.payoutNumerators;
  let denominator: BigInt = sum(event.params.payoutNumerators);
  condition.payoutDenominator = denominator;
  condition.resolveTransaction = event.transaction.hash;
  condition.resolveTimestamp = event.block.timestamp;
  condition.resolved = true;
  condition.save();
}

export function handlePositionSplit(event: PositionSplit): void {
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

  // Add this condition to participated conditions if they haven't participated in it yet
  if (!checkIfValueExistsInArray(user.participatedConditions as String[], conditionId)) {
    let userParticipatedConditions = user.participatedConditions;
    userParticipatedConditions[userParticipatedConditions.length] = conditionId;
    user.participatedConditions = userParticipatedConditions;
  }
  user.lastActive = event.block.timestamp;
  user.save();

  let parentIndexSet = sum(partition);
  let parentConditions: Array<string>;
  let parentIndexSets: Array<BigInt>;

  if (isFullIndexSet(parentIndexSet, condition.outcomeSlotCount)) {
    if (isZeroCollectionId(params.parentCollectionId)) {
      let collateralToken = Collateral.load(params.collateralToken.toHex());
      if (collateralToken == null) {
        collateralToken = new Collateral(params.collateralToken.toHex());
        collateralToken.splitCollateral = zeroAsBigInt;
        collateralToken.redeemedCollateral = zeroAsBigInt;
      }
      collateralToken.splitCollateral = collateralToken.splitCollateral.plus(params.amount);
      collateralToken.save();

      parentConditions = [];
      parentIndexSets = [];
    } else {
      let parentCollection = Collection.load(params.parentCollectionId.toHex());
      parentConditions = parentCollection.conditions;
      parentIndexSets = parentCollection.indexSets;
    }
  } else {
    let collectionId = add256(
      params.parentCollectionId,
      toCollectionId(params.conditionId, parentIndexSet)
    );
    let parentCollection = Collection.load(collectionId.toHex());
    parentConditions = new Array<string>(parentCollection.conditions.length - 1);
    parentIndexSets = new Array<BigInt>(parentConditions.length);

    for (let i = 0, j = 0; i < parentCollection.conditions.length; i++) {
      let parentCollectionConditions = parentCollection.conditions;
      let parentCollectionIndexSets = parentCollection.indexSets;
      if (parentCollectionConditions[i] !== conditionId) {
        parentConditions[j] = parentCollectionConditions[i];
        parentIndexSets[j] = parentCollectionIndexSets[i];
        j++;
      }
    }
  }

  // This part splits into 3 branches (split fullIndexSet without a parent, split fullIndexSet with a parent, split partial indexSet)
  if (isFullIndexSet(parentIndexSet, condition.outcomeSlotCount)) {
    if (isZeroCollectionId(params.parentCollectionId)) {
      // This branch covers a full splitPosition without a parentCollectionId

      for (let i = 0; i < partition.length; i++) {
        // Collection Section
        let collectionId = add256(
          params.parentCollectionId,
          toCollectionId(params.conditionId, partition[i])
        );
        let collection = Collection.load(collectionId.toHex());
        if (collection == null) {
          collection = new Collection(collectionId.toHex());
          let conditions = new Array<string>(parentConditions.length + 1);
          let indexSets = new Array<BigInt>(parentConditions.length + 1);
          for (let j = 0; j < parentConditions.length; j++) {
            conditions[j] = parentConditions[j];
            indexSets[j] = parentIndexSets[j];
          }
          conditions[parentConditions.length] = conditionId;
          indexSets[parentConditions.length] = partition[i];
          collection.conditions = conditions;
          collection.indexSets = indexSets;
          collection.save();
        }

        // Position Section
        let positionId = toPositionId(params.collateralToken, collectionId);
        let position = Position.load(positionId.toHex());
        if (position == null) {
          position = new Position(positionId.toHex());
          let conditions = new Array<string>(parentConditions.length + 1);
          let indexSets = new Array<BigInt>(parentConditions.length + 1);
          for (let j = 0; j < parentConditions.length; j++) {
            conditions[j] = parentConditions[j];
            indexSets[j] = parentIndexSets[j];
          }
          conditions[parentConditions.length] = conditionId;
          indexSets[parentConditions.length] = partition[i];
          position.conditions = conditions;
          position.indexSets = indexSets;
          position.lifetimeValue = zeroAsBigInt;
          position.collateralToken = params.collateralToken;
          position.collection = collection.id;
          position.activeValue = zeroAsBigInt;
        }
        position.activeValue = position.activeValue.plus(params.amount);
        position.lifetimeValue = position.lifetimeValue.plus(params.amount);
        position.save();

        // UserPosition Section
        let userPositionId = concat(params.stakeholder, positionId) as Bytes;
        let userPosition = UserPosition.load(userPositionId.toHex());
        if (userPosition == null) {
          userPosition = new UserPosition(userPositionId.toHex());
          userPosition.balance = zeroAsBigInt;
          userPosition.user = user.id;
          userPosition.position = position.id;
        }
        userPosition.balance = userPosition.balance.plus(params.amount);
        userPosition.save();
      }
    } else {
      // This branch covers a full splitPosition with a parentCollectionId
      for (let i = 0; i < partition.length; i++) {
        // Collection Section
        let collectionId = add256(
          params.parentCollectionId,
          toCollectionId(params.conditionId, partition[i])
        );
        let collection = Collection.load(collectionId.toHex());
        if (collection == null) {
          collection = new Collection(collectionId.toHex());
          let conditions = new Array<string>(parentConditions.length + 1);
          let indexSets = new Array<BigInt>(parentConditions.length + 1);
          for (let j = 0; j < parentConditions.length; j++) {
            conditions[j] = parentConditions[j];
            indexSets[j] = parentIndexSets[j];
          }
          conditions[parentConditions.length] = conditionId;
          indexSets[parentConditions.length] = partition[i];
          collection.conditions = conditions;
          collection.indexSets = indexSets;
          collection.save();
        }

        // Position Section
        let positionId = toPositionId(params.collateralToken, collectionId);
        let position = Position.load(positionId.toHex());
        if (position == null) {
          position = new Position(positionId.toHex());
          let conditions = new Array<string>(parentConditions.length + 1);
          let indexSets = new Array<BigInt>(parentConditions.length + 1);
          for (let j = 0; j < parentConditions.length; j++) {
            conditions[j] = parentConditions[j];
            indexSets[j] = parentIndexSets[j];
          }
          conditions[parentConditions.length] = conditionId;
          indexSets[parentConditions.length] = partition[i];
          position.conditions = conditions;
          position.indexSets = indexSets;
          position.lifetimeValue = zeroAsBigInt;
          position.collateralToken = params.collateralToken;
          position.collection = collection.id;
          position.activeValue = zeroAsBigInt;
        }
        position.activeValue = position.activeValue.plus(params.amount);
        position.lifetimeValue = position.lifetimeValue.plus(params.amount);
        position.save();

        // UserPosition Section
        let userPositionId = concat(params.stakeholder, positionId) as Bytes;
        let userPosition = UserPosition.load(userPositionId.toHex());
        if (userPosition == null) {
          userPosition = new UserPosition(userPositionId.toHex());
          userPosition.balance = zeroAsBigInt;
          userPosition.position = position.id;
          userPosition.user = user.id;
        }
        userPosition.balance = userPosition.balance.plus(params.amount);
        userPosition.save();
      }

      // Parent Position Section
      let parentPositionId = toPositionId(params.collateralToken, params.parentCollectionId);
      let parentPosition = Position.load(parentPositionId.toHex());
      parentPosition.activeValue = parentPosition.activeValue.minus(params.amount);
      parentPosition.save();

      // Parent UserPosition Section
      let parentUserPositionId = concat(params.stakeholder, parentPositionId) as Bytes;
      let parentUserPosition = UserPosition.load(parentUserPositionId.toHex());
      parentUserPosition.balance = parentUserPosition.balance.minus(params.amount);
      parentUserPosition.save();
    }
  } else {
    // This branch covers a non-full indexSet
    for (let i = 0; i < partition.length; i++) {
      // Collection Section
      let collectionId = add256(
        params.parentCollectionId,
        toCollectionId(params.conditionId, partition[i])
      );
      let collection = Collection.load(collectionId.toHex());
      if (collection == null) {
        collection = new Collection(collectionId.toHex());
        let conditions = new Array<string>(parentConditions.length + 1);
        let indexSets = new Array<BigInt>(parentConditions.length + 1);
        for (let j = 0; j < parentConditions.length; j++) {
          conditions[j] = parentConditions[j];
          indexSets[j] = parentIndexSets[j];
        }
        conditions[parentConditions.length] = conditionId;
        indexSets[parentConditions.length] = partition[i];
        collection.conditions = conditions;
        collection.indexSets = indexSets;
        collection.save();
      }

      // Position Section
      let positionId = toPositionId(params.collateralToken, collectionId);
      let position = Position.load(positionId.toHex());
      if (position == null) {
        position = new Position(positionId.toHex());
        let conditions = new Array<string>(parentConditions.length + 1);
        let indexSets = new Array<BigInt>(parentConditions.length + 1);
        for (let j = 0; j < parentConditions.length; j++) {
          conditions[j] = parentConditions[j];
          indexSets[j] = parentIndexSets[j];
        }
        conditions[parentConditions.length] = conditionId;
        indexSets[parentConditions.length] = partition[i];
        position.conditions = conditions;
        position.indexSets = indexSets;
        position.lifetimeValue = zeroAsBigInt;
        position.activeValue = zeroAsBigInt;
        position.collateralToken = params.collateralToken;
        position.collection = collection.id;
      }
      position.activeValue = position.activeValue.plus(params.amount);
      position.lifetimeValue = position.lifetimeValue.plus(params.amount);
      position.save();

      // UserPosition Section
      let userPositionId = concat(params.stakeholder, positionId) as Bytes;
      let userPosition = UserPosition.load(userPositionId.toHex());
      if (userPosition == null) {
        userPosition = new UserPosition(userPositionId.toHex());
        userPosition.balance = zeroAsBigInt;
        userPosition.position = position.id;
        userPosition.user = user.id;
      }
      userPosition.balance = userPosition.balance.plus(params.amount);
      userPosition.save();
    }

    // Union Position Section
    let parentCollectionId = add256(
      params.parentCollectionId,
      toCollectionId(params.conditionId, sum(partition))
    );
    let parentPositionId = toPositionId(params.collateralToken, parentCollectionId);
    let parentPosition = Position.load(parentPositionId.toHex());
    parentPosition.activeValue = parentPosition.activeValue.minus(params.amount);
    parentPosition.save();

    // Union UserPosition Section
    let parentUserPositionId = concat(params.stakeholder, parentPositionId) as Bytes;
    let parentUserPosition = UserPosition.load(parentUserPositionId.toHex());
    parentUserPosition.balance = parentUserPosition.balance.minus(params.amount);
    parentUserPosition.save();
  }
}

export function handlePositionsMerge(event: PositionsMerge): void {
  let params = event.params;
  let partition = params.partition;
  let totalIndexSet = sum(partition);
  let conditionId = params.conditionId.toHex();
  let condition = Condition.load(conditionId);

  // User Section
  let user = User.load(params.stakeholder.toHex());
  if (user == null) {
    user = new User(params.stakeholder.toHex());
    user.firstParticipation = event.block.timestamp;
    user.participatedConditions = [];
  }
  user.lastActive = event.block.timestamp;
  user.save();

  // This likewise splits into 3 sections (split fullIndexSet without a parent, split fullIndexSet with a parent, split partial indexSet)
  if (isFullIndexSet(totalIndexSet, condition.outcomeSlotCount)) {
    // Section: Covers merging a fullIndexSet without a parentCollection back into collateral
    if (isZeroCollectionId(params.parentCollectionId)) {
      // Collateral Section
      let collateralToken = Collateral.load(params.collateralToken.toHex());
      collateralToken.splitCollateral = collateralToken.redeemedCollateral.plus(params.amount);
      collateralToken.save();

      for (var i = 0; i < partition.length; i++) {
        // The collections and positions for this section have already been made by splitPosition event
        let collectionId = add256(
          params.parentCollectionId,
          toCollectionId(params.conditionId, partition[i])
        );
        // Position Section
        let positionId = toPositionId(params.collateralToken, collectionId);
        let position = Position.load(positionId.toHex());
        position.activeValue = position.activeValue.minus(params.amount);
        position.save();
        // UserPosition Section
        let userPositionId = concat(params.stakeholder, positionId) as Bytes;
        let userPosition = UserPosition.load(userPositionId.toHex());
        userPosition.balance = userPosition.balance.minus(params.amount);
        userPosition.save();
      }
    } else {
      // Section: Covers merging a fullIndexSet with a parentCollection into the parentCollection
      for (var j = 0; j < partition.length; j++) {
        // The collections and positions for this section have already been made by splitPosition event
        let collectionId = add256(
          params.parentCollectionId,
          toCollectionId(params.conditionId, partition[j])
        );
        // Position Section
        let positionId = toPositionId(params.collateralToken, collectionId);
        let position = Position.load(positionId.toHex());
        position.activeValue = position.activeValue.minus(params.amount);
        position.save();
        // UserPosition Section
        let userPositionId = concat(params.stakeholder, positionId) as Bytes;
        let userPosition = UserPosition.load(userPositionId.toHex());
        userPosition.balance = userPosition.balance.minus(params.amount);
        userPosition.save();
      }
      // Parent Section (Where the Merge goes into)
      let parentCollectionId = params.parentCollectionId;
      // Parent Position Section
      let parentPositionId = toPositionId(params.collateralToken, parentCollectionId);
      let parentCollectionIdPosition = Position.load(parentPositionId.toHex());
      parentCollectionIdPosition.activeValue = parentCollectionIdPosition.activeValue.plus(
        params.amount
      );
      parentCollectionIdPosition.save();
      // Parent UserPosition Section
      let parentUserPositionId = concat(params.stakeholder, parentPositionId) as Bytes;
      let parentUserPosition = UserPosition.load(parentUserPositionId.toHex());
      if (parentUserPosition == null) {
        parentUserPosition = new UserPosition(parentUserPositionId.toHex());
        parentUserPosition.balance = zeroAsBigInt;
        parentUserPosition.position = parentCollectionIdPosition.id;
        parentUserPosition.user = user.id;
      }
      parentUserPosition.balance = parentUserPosition.balance.plus(params.amount);
      parentUserPosition.save();
    }
  } else {
    // Section: Covers merging a partially full indexSet (merges into the Union Position on the same level)
    
    // Here, some extra details such as Collection and Position have to be created, because it's possible it didn't exist yet from splitPosition alone
    // Union Position & Collection & UserPosition Section
    let totalIndexSetCollectionId = add256(
      params.parentCollectionId,
      toCollectionId(params.conditionId, totalIndexSet)
    );
    let totalIndexSetPositionId = toPositionId(params.collateralToken, totalIndexSetCollectionId);
    let totalIndexSetPosition = Position.load(totalIndexSetPositionId.toHex());
    // If the Position doens't exist yet, then the Collection doesn't either, and both must be created and populated with the correct Conditions / IndexSets
    if (totalIndexSetPosition == null) {
      // Collection Section
      let totalIndexSetCollection = Collection.load(totalIndexSetCollectionId.toHex());
      if (totalIndexSetCollection == null) {
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
        totalIndexSetCollectionIndexSets[totalIndexSetCollectionConditions.length] = totalIndexSet;
        totalIndexSetCollection = new Collection(totalIndexSetCollectionId.toHex());
        totalIndexSetCollection.conditions = totalIndexSetCollectionConditions;
        totalIndexSetCollectionIndexSets = totalIndexSetCollectionIndexSets;
        totalIndexSetCollection.save();
      }
      // Position Section
      totalIndexSetPosition = new Position(totalIndexSetPositionId.toHex());
      totalIndexSetPosition.collateralToken = params.collateralToken;
      totalIndexSetPosition.collection = totalIndexSetCollection.id;
      totalIndexSetPosition.lifetimeValue = zeroAsBigInt;
      totalIndexSetPosition.activeValue = zeroAsBigInt;
      // need to add conditions and indexSets to this position
    }
    totalIndexSetPosition.activeValue = totalIndexSetPosition.activeValue.plus(params.amount);
    totalIndexSetPosition.lifetimeValue = totalIndexSetPosition.lifetimeValue.plus(params.amount);
    totalIndexSetPosition.save();
    // Union UserPosition Section
    let unionPositionId = toPositionId(
      params.collateralToken,
      toCollectionId(params.conditionId, totalIndexSet)
    );
    let unionUserPositionId = concat(params.stakeholder, unionPositionId) as Bytes;
    let unionUserPosition = UserPosition.load(unionUserPositionId.toHex());
    if (unionUserPosition == null) {
      unionUserPosition = new UserPosition(unionUserPositionId.toHex());
      unionUserPosition.user = user.id;
      unionUserPosition.position = totalIndexSetPosition.id;
      unionUserPosition.balance = zeroAsBigInt;
    }
    unionUserPosition.balance = unionUserPosition.balance.plus(params.amount);
    unionUserPosition.save();

    // This is the section of Positions that will be merged, they will already be in the system
    for (var k = 0; k < partition.length; k++) {
      let collectionId = add256(
        params.parentCollectionId,
        toCollectionId(params.conditionId, partition[i])
      );
      // Position Section
      let positionId = toPositionId(params.collateralToken, collectionId);
      let position = Position.load(positionId.toHex());
      position.activeValue = position.activeValue.minus(params.amount);
      position.save();
      // UserPosition Section
      let userPositionId = concat(params.stakeholder, positionId) as Bytes;
      let userPosition = UserPosition.load(userPositionId.toHex());
      if ((userPosition = null)) {
        userPosition = new UserPosition(userPositionId.toHex());
        userPosition.balance = zeroAsBigInt;
        userPosition.user = user.id;
        userPosition.position = Position.load(positionId.toHex()).id;
      }
      userPosition.balance = userPosition.balance.minus(params.amount);
      userPosition.save();
    }
  }
}

export function handlePayoutRedemption(event: PayoutRedemption): void {
  let params = event.params;
  let indexSets = params.indexSets;
  let conditionId = params.conditionId.toHex();

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
  for (var i = 0; i < indexSets.length; i++) {
    let collectionId = add256(
      params.parentCollectionId,
      toCollectionId(params.conditionId, indexSets[i])
    );
    let positionId = toPositionId(params.collateralToken, collectionId);
    let userPositionId = concat(params.redeemer, positionId) as Bytes;
    let userPosition = UserPosition.load(userPositionId.toHex());
    let position = Position.load(positionId.toHex());
    position.activeValue = position.activeValue.minus(userPosition.balance);
    position.save();
    userPosition.balance = zeroAsBigInt;
    userPosition.save();
  }
}

export function handleTransferSingle(event: TransferSingle): void {
  let params = event.params;

  // the Position & UserPosition of the _from address should already be in the system
  let position = Position.load(bigIntToBytes32(params._id).toHex());
  let _fromUserPositionId = concat(params._from, bigIntToBytes32(params._id)) as Bytes;
  let _fromUserPosition = UserPosition.load(_fromUserPositionId.toHex());
  _fromUserPosition.balance = _fromUserPosition.balance.minus(params._value);
  _fromUserPosition.save();

  // User Section
  let _fromUser = User.load(params._from.toHex());
  _fromUser.lastActive = event.block.timestamp;
  let _toUser = User.load(params._to.toHex());
  if (_toUser == null) {
    _toUser = new User(params._to.toHex());
    _toUser.firstParticipation = event.block.timestamp;
    _toUser.participatedConditions = [];
  }
  // Update _toUser.participatedConditions
  let clonePositionsConditions = position.conditions;
  for (var q = 0; q < clonePositionsConditions.length; q++) {
    if (
      !checkIfValueExistsInArray(
        _toUser.participatedConditions as String[],
        clonePositionsConditions[q]
      )
    ) {
      let _toUserParticipatedConditions = _toUser.participatedConditions;
      _toUserParticipatedConditions[_toUserParticipatedConditions.length] =
        clonePositionsConditions[q];
      _toUser.participatedConditions = _toUserParticipatedConditions;
      _toUser.save();
    }
  }
  _toUser.lastActive = event.block.timestamp;
  _toUser.save();

  // _toUser UserPosition Section
  let _toUserPositionId = concat(params._to, bigIntToBytes32(params._id)) as Bytes;
  let _toUserPosition = UserPosition.load(_toUserPositionId.toHex());
  if (_toUserPosition == null) {
    _toUserPosition = new UserPosition(_toUserPositionId.toHex());
    _toUserPosition.user = _toUser.id;
    _toUserPosition.balance = zeroAsBigInt;
    _toUserPosition.position = position.id;
  }
  _toUserPosition.balance = _toUserPosition.balance.plus(params._value);
  _toUserPosition.save();

  // Update the Operator
  let operator = Operator.load(params._operator.toHex());
  if (operator == null) {
    operator = new Operator(params._operator.toHex());
    operator.totalValueTransferred = zeroAsBigInt;
    operator.associatedAccounts = [];
    operator.firstParticipation = event.block.timestamp;
    operator.lastActive = event.block.timestamp;
  }
  operator.totalValueTransferred = operator.totalValueTransferred.plus(params._value);
  let clonedOperatorAssociatedAccounts = operator.associatedAccounts;
  if (!checkIfValueExistsInArray(clonedOperatorAssociatedAccounts, params._to.toHex())) {
    clonedOperatorAssociatedAccounts[clonedOperatorAssociatedAccounts.length] = params._to.toHex();
  }
  if (!checkIfValueExistsInArray(clonedOperatorAssociatedAccounts, params._from.toHex())) {
    clonedOperatorAssociatedAccounts[
      clonedOperatorAssociatedAccounts.length
    ] = params._from.toHex();
  }
  operator.lastActive = event.block.timestamp;
  operator.associatedAccounts = clonedOperatorAssociatedAccounts;
  operator.save();
}

export function handleTransferBatch(event: TransferBatch): void {
  let params = event.params;
  let summedValue = sum(params._values);

  // User Section
  let _fromUser = User.load(params._from.toHex());
  _fromUser.lastActive = event.block.timestamp;
  let _toUser = User.load(params._to.toHex());
  if (_toUser == null) {
    _toUser = new User(params._to.toHex());
    _toUser.firstParticipation = event.block.timestamp;
    _toUser.participatedConditions = [];
  }
  _toUser.lastActive = event.block.timestamp;
  _toUser.save();

  // Copies of variables for AssemblyScript memory
  let _positionIds: Array<BigInt> = params._ids;
  let _values: Array<BigInt> = params._values;
  let copyPositionIds = new Array<BigInt>(params._ids.length);
  let copyValues = new Array<BigInt>(params._values.length);

  for (var i = 0; i < params._ids.length; i++) {
    copyPositionIds[i] = _positionIds[i];
    copyValues[i] = _values[i];

    let clonePositionsConditions = Position.load(copyPositionIds[i].toHex()).conditions;
    for (var q = 0; q < clonePositionsConditions.length; q++) {
      if (
        !checkIfValueExistsInArray(
          _toUser.participatedConditions as String[],
          clonePositionsConditions[q]
        )
      ) {
        let _toUserParticipatedConditions = _toUser.participatedConditions;
        _toUserParticipatedConditions[_toUserParticipatedConditions.length] =
          clonePositionsConditions[q];
        _toUser.participatedConditions = _toUserParticipatedConditions;
        _toUser.save();
      }
    }
    // _from UserPosition Section
    let bytesPositionId = bigIntToBytes32(copyPositionIds[i]);
    let _fromUserPositionId = concat(params._from, bytesPositionId) as Bytes;
    let _fromUserPosition = UserPosition.load(_fromUserPositionId.toHex());
    _fromUserPosition.balance = _fromUserPosition.balance.minus(copyValues[i]);
    _fromUserPosition.save();
    // _to UserPosition Section
    let _toUserPositionId = concat(params._to, bigIntToBytes32(copyPositionIds[i])) as Bytes;
    let _toUserPosition = UserPosition.load(_toUserPositionId.toHex());
    if (_toUserPosition == null) {
      _toUserPosition = new UserPosition(_toUserPositionId.toHex());
      _toUserPosition.user = _toUser.id;
      let position = Position.load(bigIntToBytes32(copyPositionIds[i]).toHex());
      _toUserPosition.position = position.id;
      _toUserPosition.balance = zeroAsBigInt;
    }
    _toUserPosition.balance = _toUserPosition.balance.plus(copyValues[i]);
    _toUserPosition.save();
  }

  // Operator Section
  let operator = Operator.load(params._operator.toHex());
  if (operator == null) {
    operator = new Operator(params._operator.toHex());
    operator.totalValueTransferred = zeroAsBigInt;
    operator.associatedAccounts = [];
    operator.firstParticipation = event.block.timestamp;
    operator.lastActive = event.block.timestamp;
  }
  operator.totalValueTransferred = operator.totalValueTransferred.plus(summedValue);
  let clonedOperatorAssociatedAccounts = operator.associatedAccounts;
  if (!checkIfValueExistsInArray(clonedOperatorAssociatedAccounts, params._to.toHex())) {
    clonedOperatorAssociatedAccounts[clonedOperatorAssociatedAccounts.length] = params._to.toHex();
  }
  if (!checkIfValueExistsInArray(clonedOperatorAssociatedAccounts, params._from.toHex())) {
    clonedOperatorAssociatedAccounts[
      clonedOperatorAssociatedAccounts.length
    ] = params._from.toHex();
  }
  operator.lastActive = event.block.timestamp;
  operator.associatedAccounts = clonedOperatorAssociatedAccounts;
  operator.save();
}

// Helper functions
function sum(a: BigInt[]): BigInt {
  let result: BigInt = zeroAsBigInt;
  for (let i = 0; i < a.length; i++) {
    result = result.plus(a[i]);
  }
  return result;
}

function toCollectionId(conditionId: Bytes, indexSet: BigInt): Bytes {
  let hashPayload = new Uint8Array(64);
  hashPayload.fill(0);
  for (let i = 0; i < conditionId.length && i < 32; i++) {
    hashPayload[i] = conditionId[i];
  }
  for (let i = 0; i < indexSet.length && i < 32; i++) {
    hashPayload[63 - i] = indexSet[i];
  }
  return crypto.keccak256(hashPayload as Bytes) as Bytes;
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

function add256(a: Bytes, b: Bytes): Bytes {
  let aBigInt = new Uint8Array(32) as BigInt;
  let bBigInt = new Uint8Array(32) as BigInt;

  aBigInt.fill(0);
  for (let i = 0; i < a.length && i < 32; i++) {
    aBigInt[i] = a[a.length - 1 - i];
  }

  bBigInt.fill(0);
  for (let i = 0; i < b.length && i < 32; i++) {
    bBigInt[i] = b[b.length - 1 - i];
  }

  let sumBigInt = aBigInt.plus(bBigInt);
  return bigIntToBytes32(sumBigInt);
}

function isFullIndexSet(indexSet: BigInt, outcomeSlotCount: i32): boolean {
  for (let i = 0; i < indexSet.length && 8 * i < outcomeSlotCount; i++) {
    let bitsLeft = outcomeSlotCount - 8 * i;
    if (bitsLeft < 8) {
      if (indexSet[i] !== (1 << (bitsLeft as u8)) - 1) return false;
    } else {
      if (indexSet[i] !== 0xff) return false;
    }
  }
  return true;
}

function isZeroCollectionId(collectionId: Bytes): boolean {
  for (let i = 0; i < collectionId.length; i++) if (collectionId[i] !== 0) return false;
  return true;
}

function bigIntToBytes32(bigInt: BigInt): Bytes {
  let sum = new Uint8Array(32) as Bytes;
  sum.fill(0);
  for (let i = 0; i < bigInt.length && i < 32; i++) {
    sum[31 - i] = bigInt[i];
  }
  return sum;
}

function concat(a: ByteArray, b: ByteArray): ByteArray {
  let out = new Uint8Array(a.length + b.length);
  for (let i = 0; i < a.length; i++) {
    out[i] = a[i];
  }
  for (let j = 0; j < b.length; j++) {
    out[a.length + j] = b[j];
  }
  return out as ByteArray;
}

export function checkIfValueExistsInArray(
  participatedConditions: String[],
  condition: String
): boolean {
  for (let i = 0; i < participatedConditions.length; i++) {
    if (participatedConditions[i] == condition) {
      return true;
    }
  }
  return false;
}
