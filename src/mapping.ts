import { crypto, Address, BigInt, Bytes, TypedMap, ByteArray } from '@graphprotocol/graph-ts'
import { ConditionPreparation, ConditionResolution, PositionSplit, PositionsMerge, PredictionMarketSystem, PayoutRedemption, TransferSingle, TransferBatch } from './types/PredictionMarketSystem/PredictionMarketSystem'
import { Condition, Collection, Position, User, UserPosition } from './types/schema'

let zeroAsBigInt: BigInt = BigInt.fromI32(0);

export function handleConditionPreparation(event: ConditionPreparation): void {
  let condition = new Condition(event.params.conditionId.toHex())
  condition.creator = event.transaction.from
  condition.oracle = event.params.oracle
  condition.questionId = event.params.questionId
  condition.outcomeSlotCount = event.params.outcomeSlotCount.toI32()
  condition.resolved = false
  condition.createTransaction = event.transaction.hash
  condition.creationTimestamp = event.block.timestamp
  condition.blockNumber = event.block.number
  condition.save()
}

export function handleConditionResolution(event: ConditionResolution): void {
  let condition = Condition.load(event.params.conditionId.toHex())
  condition.payoutNumerators = event.params.payoutNumerators
  let denominator: BigInt = sum(event.params.payoutNumerators)
  condition.payoutDenominator = denominator
  condition.resolveTransaction = event.transaction.hash
  condition.resolveTimestamp = event.block.timestamp
  condition.resolved = true;
  condition.save()
}

export function handlePositionSplit(event: PositionSplit): void {
  let params = event.params
  let partition = params.partition
  let conditionId = params.conditionId.toHex()
  let condition = Condition.load(conditionId)

  let user = User.load(params.stakeholder.toHex())
  if (user == null) {
    user = new User(params.stakeholder.toHex());
    user.save();
  } 

  let parentIndexSet = sum(partition)
  let parentConditions: Array<String>
  let parentIndexSets: Array<BigInt>  

  if(isFullIndexSet(parentIndexSet, condition.outcomeSlotCount)) {
    if(isZeroCollectionId(params.parentCollectionId)) {
      parentConditions = []
      parentIndexSets = []
    } else {
      let parentCollection = Collection.load(params.parentCollectionId.toHex())
      parentConditions = parentCollection.conditions
      parentIndexSets = parentCollection.indexSets
    }
  } else {
    let collectionId = add256(params.parentCollectionId, toCollectionId(params.conditionId, parentIndexSet))
    let parentCollection = Collection.load(collectionId.toHex())
    parentConditions = new Array<String>(parentCollection.conditions.length - 1)
    parentIndexSets = new Array<BigInt>(parentConditions.length)

    for(let i = 0, j = 0; i < parentCollection.conditions.length; i++) {
      let parentCollectionConditions = parentCollection.conditions
      let parentCollectionIndexSets = parentCollection.indexSets
      if(parentCollectionConditions[i] !== conditionId) {
        parentConditions[j] = parentCollectionConditions[i]
        parentIndexSets[j] = parentCollectionIndexSets[i]
        j++
      }
    }
  }

  if (isFullIndexSet(parentIndexSet, condition.outcomeSlotCount)) {
    if (isZeroCollectionId(params.parentCollectionId)) {
      // This branch covers a full splitPosition without a parentCollectionId
      for (let i=0; i<partition.length; i++) {
        let collectionId = add256(params.parentCollectionId, toCollectionId(params.conditionId, partition[i]))
        let collection = Collection.load(collectionId.toHex())
        if (collection == null) {
          collection = new Collection(collectionId.toHex())
          let conditions = new Array<String>(parentConditions.length + 1)
          let indexSets = new Array<BigInt>(parentConditions.length + 1)
          for(let j = 0; j < parentConditions.length; j++) {
            conditions[j] = parentConditions[j]
            indexSets[j] = parentIndexSets[j]
          }
          conditions[parentConditions.length] = conditionId
          indexSets[parentConditions.length] = partition[i]
          collection.conditions = conditions
          collection.indexSets = indexSets
          collection.save()
        }
        let positionId = toPositionId(params.collateralToken, collectionId)
        let position = Position.load(positionId.toHex())
        if (position == null) {
          position = new Position(positionId.toHex())
          position.lifetimeValue = zeroAsBigInt;
          position.collateralToken = params.collateralToken
          position.collection = collection.id
        }
        position.lifetimeValue = position.lifetimeValue.plus(params.amount);
        position.save()
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
    // This branch covers a full splitPosition with a parentCollectionId
    } else {
      for (let i=0; i<partition.length; i++) {
        let collectionId = add256(params.parentCollectionId, toCollectionId(params.conditionId, partition[i]))
        let collection = Collection.load(collectionId.toHex())
        if (collection == null) {
          collection = new Collection(collectionId.toHex())
          let conditions = new Array<String>(parentConditions.length + 1)
          let indexSets = new Array<BigInt>(parentConditions.length + 1)
          for(let j = 0; j < parentConditions.length; j++) {
            conditions[j] = parentConditions[j]
            indexSets[j] = parentIndexSets[j]
          }
          conditions[parentConditions.length] = conditionId
          indexSets[parentConditions.length] = partition[i]
          collection.conditions = conditions
          collection.indexSets = indexSets
          collection.save()
        }
        let positionId = toPositionId(params.collateralToken, collectionId)
        let position = Position.load(positionId.toHex())
        if (position == null) {
          position = new Position(positionId.toHex())
          position.lifetimeValue = zeroAsBigInt;
          position.collateralToken = params.collateralToken
          position.collection = collection.id;
        }
        position.lifetimeValue = position.lifetimeValue.plus(params.amount);
        position.save()
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
      // Subtract from parent positions balance
      let parentPositionId = toPositionId(params.collateralToken, params.parentCollectionId);
      let parentUserPositionId = concat(params.stakeholder, parentPositionId) as Bytes;
      let parentPosition = UserPosition.load(parentUserPositionId.toHex());
      parentPosition.balance = parentPosition.balance.minus(params.amount);
      parentPosition.save();
    }
  // This branch covers a non-full indexSet, which has to have a parentId 
  } else {
    for (let i=0; i<partition.length; i++) {
      let collectionId = add256(params.parentCollectionId, toCollectionId(params.conditionId, partition[i]))
      let collection = Collection.load(collectionId.toHex())
      if (collection == null) {
        collection = new Collection(collectionId.toHex())
        let conditions = new Array<String>(parentConditions.length + 1)
        let indexSets = new Array<BigInt>(parentConditions.length + 1)
        for(let j = 0; j < parentConditions.length; j++) {
          conditions[j] = parentConditions[j]
          indexSets[j] = parentIndexSets[j]
        }
        conditions[parentConditions.length] = conditionId
        indexSets[parentConditions.length] = partition[i]
        collection.conditions = conditions
        collection.indexSets = indexSets
        collection.save()
      }
      let positionId = toPositionId(params.collateralToken, collectionId)
      let position = Position.load(positionId.toHex())
      if (position == null) {
        position = new Position(positionId.toHex())
        position.lifetimeValue = zeroAsBigInt;
        position.collateralToken = params.collateralToken
        position.collection = collection.id
      }
      position.lifetimeValue = position.lifetimeValue.plus(params.amount);
      position.save()
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
    // Subtract from parent positions balance
    let parentCollectionId = add256(params.parentCollectionId, toCollectionId(params.conditionId, sum(partition)));
    let parentPositionId = toPositionId(params.collateralToken, parentCollectionId);
    let parentUserPositionId = concat(params.stakeholder, parentPositionId) as Bytes;
    let parentUserPosition = UserPosition.load(parentUserPositionId.toHex());
    parentUserPosition.balance = parentUserPosition.balance.minus(params.amount);
    parentUserPosition.save();
  }
}

export function handlePositionsMerge(event: PositionsMerge): void {
  let params = event.params
  let partition = params.partition
  let conditionId = params.conditionId.toHex()
  let condition = Condition.load(conditionId)

  let user = User.load(params.stakeholder.toHex())
  if (user == null) {
    user = new User(params.stakeholder.toHex());
    user.save();
  } 
  let totalIndexSet = sum(partition);

  if(isFullIndexSet(totalIndexSet, condition.outcomeSlotCount)) {
    if(isZeroCollectionId(params.parentCollectionId)) {
      // If it's a full indexset without a parent collection 
        // just lower the balance for each position
        for (var i=0; i< partition.length; i++) {
          let collectionId = add256(params.parentCollectionId, toCollectionId(params.conditionId, partition[i]));
          let positionId = toPositionId(params.collateralToken, collectionId);
          let userPositionId = concat(params.stakeholder, positionId) as Bytes;
          let userPosition = UserPosition.load(userPositionId.toHex());
          userPosition.balance = userPosition.balance.minus(params.amount);
          userPosition.save();
        }
    } else {
      // If it's a full indexset with a parent collection
      // lower the balance for each position
      for (var j=0; j< partition.length; j++) {
        let collectionId = add256(params.parentCollectionId, toCollectionId(params.conditionId, partition[j]));
        let positionId = toPositionId(params.collateralToken, collectionId);
        let userPositionId = concat(params.stakeholder, positionId) as Bytes;
        let userPosition = UserPosition.load(userPositionId.toHex())
        userPosition.balance = userPosition.balance.minus(params.amount);
        userPosition.save();
      }
      // increase the balance for the parentCollection
      let parentCollectionId = params.parentCollectionId;
      let parentPositionId = toPositionId(params.collateralToken, parentCollectionId);
      let parentCollectionIdPosition = Position.load(parentPositionId.toHex());
      let parentUserPositionId = concat(params.stakeholder, parentPositionId) as Bytes;
      let parentUserPosition = UserPosition.load(parentUserPositionId.toHex());
      if (parentUserPosition == null) {
        parentUserPosition = new UserPosition(parentUserPositionId.toHex());
        parentUserPosition.balance = zeroAsBigInt;
        parentUserPosition.position = parentCollectionIdPosition.id;
        parentUserPosition.user = user.id;
      }
      parentUserPosition.balance = parentUserPosition.balance.minus(params.amount);
      parentUserPosition.save();
    }
  } else {
    let totalIndexSetCollectionId = add256(params.parentCollectionId, toCollectionId(params.conditionId, totalIndexSet));
    let totalIndexSetPositionId = toPositionId(params.collateralToken, totalIndexSetCollectionId);
    let totalIndexSetPosition = Position.load(totalIndexSetPositionId.toHex());
    if (totalIndexSetPosition == null) {
      // get the collectionId & positionID of the union of indexsets
      let totalIndexSetCollection = Collection.load(totalIndexSetCollectionId.toHex());
      if (totalIndexSetCollection == null) {
        // load or create the parentCollectionId Position
        let parentCollection = Collection.load(params.parentCollectionId.toHex());
        let parentCollectionConditionsList = parentCollection.conditions;
        let parentCollectionIndexSetsList = parentCollection.indexSets;

        let totalIndexSetCollectionConditions = new Array<String>(parentCollection.conditions.length + 1);
        let totalIndexSetCollectionIndexSets = new Array<BigInt>(parentCollection.conditions.length + 1);
        for (var m=0; m < parentCollection.conditions.length; m++) {
          totalIndexSetCollectionConditions[m] = parentCollectionConditionsList[m];
          totalIndexSetCollectionIndexSets[m] = parentCollectionIndexSetsList[m];
        }
        totalIndexSetCollectionConditions[totalIndexSetCollectionConditions.length] = params.conditionId.toHex();
        totalIndexSetCollectionIndexSets[totalIndexSetCollectionConditions.length] = totalIndexSet;
        
        totalIndexSetCollection = new Collection(totalIndexSetCollectionId.toHex());
        totalIndexSetCollection.conditions = totalIndexSetCollectionConditions;
        totalIndexSetCollectionIndexSets = totalIndexSetCollectionIndexSets;
        totalIndexSetCollection.save();
      }
      totalIndexSetPosition = new Position(totalIndexSetPositionId.toHex());
      totalIndexSetPosition.collateralToken = params.collateralToken;
      totalIndexSetPosition.collection = totalIndexSetCollection.id;
      totalIndexSetPosition.lifetimeValue = zeroAsBigInt;
    }
    totalIndexSetPosition.lifetimeValue = totalIndexSetPosition.lifetimeValue.plus(params.amount);
    totalIndexSetPosition.save();
    // lower the balance of each partition UserPosition (these positions will already be in the system)
    for (var k=0; k< partition.length; k++) {
      let collectionId = add256(params.parentCollectionId, toCollectionId(params.conditionId, partition[i]));
      let positionId = toPositionId(params.collateralToken, collectionId);
      let userPositionId = concat(params.stakeholder, positionId) as Bytes;
      let userPosition = UserPosition.load(userPositionId.toHex());
      if (userPosition = null) {
        userPosition = new UserPosition(userPositionId.toHex());
        userPosition.balance = zeroAsBigInt;
        userPosition.user = user.id;
        userPosition.position = Position.load(positionId.toHex()).id; 
      }
      userPosition.balance = userPosition.balance.minus(params.amount);
      userPosition.save();
    }
    // increase the balance of the union UserPosition (this UserPosition may not be in the system)
    let unionPositionId = toPositionId(params.collateralToken, toCollectionId(params.conditionId, totalIndexSet));
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
  }
}


export function handlePayoutRedemption(event: PayoutRedemption): void {
  let params = event.params;
  let indexSets = params.indexSets;
  let user = User.load(params.redeemer.toHex())
  if (user == null) {
    user = new User(params.redeemer.toHex());
    user.save();
  } 
  // put all the UserPositions from the indexSet list to 0
  // add params.totalPayout to the parentCollectionId if there is one
  if (!isZeroCollectionId(params.parentCollectionId)) {
    let parentPositionId = toPositionId(params.collateralToken, params.parentCollectionId);
    let parentPosition = Position.load(parentPositionId.toHex());
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

  for (var i=0; i<indexSets.length; i++) {
    let collectionId = add256(params.parentCollectionId, toCollectionId(params.conditionId, indexSets[i]));
    let positionId = toPositionId(params.collateralToken, collectionId);
    let userPositionId = concat(params.redeemer, positionId) as Bytes;
    let userPosition = UserPosition.load(userPositionId.toHex());
    userPosition.balance = zeroAsBigInt;
    userPosition.save();
  }
}

export function handleTransferSingle(event: TransferSingle): void {
  let params = event.params;
  // if you're doing a transfer the position should already be in the system
    // the UserPosition of the _from address should already be in the system
  let position = Position.load(params._id.toHex());
  let _fromUserPositionId = concat(params._from, bigIntToBytes32(params._id)) as Bytes;
  let _fromUserPosition = UserPosition.load(_fromUserPositionId.toHex());
  _fromUserPosition.balance = _fromUserPosition.balance.minus(params._value);
  _fromUserPosition.save();

  // The _to UserPosition doesn't have to be in the system
  let _toUser = User.load(params._to.toHex());
  if (_toUser == null) {
    _toUser = new User(params._to.toHex());
    _toUser.save();
  }

  let _toUserPositionId = concat(params._to, bigIntToBytes32(params._id)) as Bytes;
  let _toUserPosition = UserPosition.load(_toUserPositionId.toHex());
  if (_toUserPosition  == null) {
    _toUserPosition = new UserPosition(_toUserPositionId.toHex());
    _toUserPosition.user = _toUser.id;
    _toUserPosition.balance = zeroAsBigInt;
    _toUserPosition.position = position.id;
  } 
  _toUserPosition.balance = _toUserPosition.balance.plus(params._value)
  _toUserPosition.save();
}

export function handleTransferBatch(event: TransferBatch): void {
  let params = event.params;
  // The _to UserPosition doesn't have to be in the system
  let _toUser = User.load(params._to.toHex());
  if (_toUser == null) {
    _toUser = new User(params._to.toHex());
  }

  // copies of variables for AssemblyScript memory issues 
  let _positionIds = params._ids;
  let _values = params._values;
  let copyPositionIds = new Array<BigInt>(params._ids.length);
  let copyValues = new Array<BigInt>(params._values.length);
  
  // if you're doing a transfer the position should already be in the system
  // the UserPosition of the _from address should likewise already be in the system
  for (var i=0; i < params._ids.length; i++) {
    copyPositionIds[i] = _positionIds[i];
    copyValues[i] = _values[i];
    let bytesPositionId = bigIntToBytes32(copyPositionIds[i]);
    let _fromUserPositionId = concat(params._from, bytesPositionId) as Bytes;
    let _fromUserPosition = UserPosition.load(_fromUserPositionId.toHex());
    _fromUserPosition.balance = _fromUserPosition.balance.minus(copyValues[i]);
    _fromUserPosition.save();

    let _toUserPositionId = concat(params._to, bigIntToBytes32(copyPositionIds[i])) as Bytes;
    let _toUserPosition = UserPosition.load(_toUserPositionId.toHex());
    if (_toUserPosition  == null) {
      _toUserPosition = new UserPosition(_toUserPositionId.toHex());
      _toUserPosition.user = _toUser.id;
      let position = Position.load(bigIntToBytes32(copyPositionIds[i]).toHex());
      _toUserPosition.position = position.id;
      _toUserPosition.balance = zeroAsBigInt;
    } 
    _toUserPosition.balance = _toUserPosition.balance.plus(copyValues[i]);
    _toUserPosition.save();
  }
}

// Helper functions (mandated by AssemblyScript for memory issues)
function sum(a: BigInt[]): BigInt {
  let result: BigInt = 0;
  for (let i = 0; i < a.length; i++) {
    result = result + a[i]
  }
  return result;
}

function sumBigInt(a: BigInt, b: BigInt): BigInt {
  return a.plus(b);
}

function toCollectionId(conditionId: Bytes, indexSet: BigInt): Bytes {
  let hashPayload = new Uint8Array(64)
  hashPayload.fill(0)
  for(let i = 0; i < conditionId.length && i < 32; i++) {
    hashPayload[i] = conditionId[i]
  }
  for(let i = 0; i < indexSet.length && i < 32; i++) {
    hashPayload[63 - i] = indexSet[i]
  }
  return crypto.keccak256(hashPayload as Bytes) as Bytes
}

function toPositionId(collateralToken: Address, collectionId: Bytes): Bytes {
  let hashPayload = new Uint8Array(52)
  hashPayload.fill(0)
  for(let i = 0; i < collateralToken.length && i < 20; i++) {
    hashPayload[i] = collateralToken[i]
  }
  for(let i = 0; i < collectionId.length && i < 32; i++) {
    hashPayload[i + 20] = collectionId[i]
  }
  return crypto.keccak256(hashPayload as Bytes) as Bytes
}

function add256(a: Bytes, b: Bytes): Bytes {
  let aBigInt = new Uint8Array(32) as BigInt
  let bBigInt = new Uint8Array(32) as BigInt

  aBigInt.fill(0)
  for(let i = 0; i < a.length && i < 32; i++) {
    aBigInt[i] = a[a.length - 1 - i]
  }

  bBigInt.fill(0)
  for(let i = 0; i < b.length && i < 32; i++) {
    bBigInt[i] = b[b.length - 1 - i]
  }

  let sumBigInt = aBigInt + bBigInt
  return bigIntToBytes32(sumBigInt);
}

function isFullIndexSet(indexSet: BigInt, outcomeSlotCount: i32): boolean {
  for(let i = 0; i < indexSet.length && 8 * i < outcomeSlotCount; i++) {
    let bitsLeft = outcomeSlotCount - 8 * i
    if(bitsLeft < 8) {
      if(indexSet[i] !== (1 << (bitsLeft as u8)) - 1) return false
    } else {
      if(indexSet[i] !== 0xff) return false
    }
  }
  return true
}

function isZeroCollectionId(collectionId: Bytes): boolean {
  for(let i = 0; i < collectionId.length; i++)
    if(collectionId[i] !== 0)
      return false
  return true
}

function bigIntToBytes32(bigInt: BigInt): Bytes {
  let sum = new Uint8Array(32) as Bytes
  sum.fill(0)
  for(let i = 0; i < bigInt.length && i < 32; i++) {
    sum[31 - i] = bigInt[i]
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

