import { crypto, Address, BigInt, Bytes, TypedMap, ByteArray } from '@graphprotocol/graph-ts'
import { ConditionPreparation, ConditionResolution, PositionSplit, PositionsMerge, PredictionMarketSystem, PayoutRedemption, TransferSingle, TransferBatch } from './types/PredictionMarketSystem/PredictionMarketSystem'
import { Condition, Collection, Position, User, UserPosition } from './types/schema'

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
          position.collateralToken = params.collateralToken
          position.collection = collection.id
          position.save()
        }
        // UserPosition Section
        let userPositionId = concat(params.stakeholder, positionId) as Bytes; 
        let userPosition = UserPosition.load(userPositionId.toHex());
        if (userPosition == null) {
          userPosition = new UserPosition(userPositionId.toHex());
          userPosition.balance = 0;
          userPosition.user = user.id;
          userPosition.position = position.id;
        }
        userPosition.balance += params.amount;
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
          position.collateralToken = params.collateralToken
          position.collection = collection.id
          position.save()
        }
        // UserPosition Section
        let userPositionId = concat(params.stakeholder, positionId) as Bytes; 
        let userPosition = UserPosition.load(userPositionId.toHex());
        if (userPosition == null) {
          userPosition = new UserPosition(userPositionId.toHex());
          userPosition.balance = 0;
          userPosition.position = position.id;
          userPosition.user = user.id;
        }
        userPosition.balance += params.amount;
        userPosition.save();
      }
      // Subtract from parent positions balance
      let parentPositionId = toPositionId(params.collateralToken, params.parentCollectionId);
      let parentUserPositionId = concat(params.stakeholder, parentPositionId) as Bytes;
      let parentPosition = UserPosition.load(parentUserPositionId.toHex());
      parentPosition.balance -= params.amount;
      parentPosition.save();
    }
  // This branch covers a non-full indexSet, which has to have a parentId (?)
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
        position.collateralToken = params.collateralToken
        position.collection = collection.id
        position.save()
      }
      // UserPosition Section
      let userPositionId = concat(params.stakeholder, positionId) as Bytes; 
      let userPosition = UserPosition.load(userPositionId.toHex());
      if (userPosition == null) {
        userPosition = new UserPosition(userPositionId.toHex());
        userPosition.balance = 0;
        userPosition.position = position.id;
        userPosition.user = user.id;
      }
      userPosition.balance += params.amount;
      userPosition.save();
    }
    // Subtract from parent positions balance
    let parentCollectionId = add256(params.parentCollectionId, toCollectionId(params.conditionId, parentIndexSet));
    let parentPositionId = toPositionId(params.collateralToken, parentCollectionId);
    let parentUserPositionId = concat(params.stakeholder, parentPositionId) as Bytes;
    let parentPosition = UserPosition.load(parentUserPositionId.toHex());
    parentPosition.balance -= params.amount;
    parentPosition.save();
  }
}

export function handlePositionsMerge(event: PositionsMerge): void {
  // let params = event.params
  // let partition = params.partition
  // let conditionId = params.conditionId.toHex()
  // let condition = Condition.load(conditionId)

  // let user = User.load(params.stakeholder.toHex())
  // if (user == null) {
  //   user = new User(params.stakeholder.toHex());
  //   user.save();
  // } 
  // let totalIndexSet = sum(partition);

  // if(isFullIndexSet(totalIndexSet, condition.outcomeSlotCount)) {
  //   if(isZeroCollectionId(params.parentCollectionId)) {
  //     // If it's a full indexset without a parent collection 
  //       // just lower the balance for each position
  //       for (var i=0; i< partition.length; i++) {
  //         let collectionId = add256(params.parentCollectionId, toCollectionId(params.conditionId, partition[i]));
  //         let positionId = toPositionId(params.collateralToken, collectionId);
  //         let userPositionId = concat(params.stakeholder, positionId) as Bytes;
  //         let userPosition = UserPosition.load(userPositionId.toHex());
  //         userPosition.balance -= params.amount;
  //         userPosition.save();
  //       }
  //   } else {
  //     // If it's a full indexset with a parent collection
  //       // lower the balance for each position
  //       for (var j=0; j< partition.length; j++) {
  //         let collectionId = add256(params.parentCollectionId, toCollectionId(params.conditionId, partition[i]));
  //         let positionId = toPositionId(params.collateralToken, collectionId);
  //         let userPositionId = concat(params.stakeholder, positionId) as Bytes;
  //         let userPosition = UserPosition.load(userPositionId.toHex());
  //         userPosition.balance -= params.amount;
  //         userPosition.save();
  //       }
  //       // increase the balance for the parentCollection
  //       let parentCollectionId = params.parentCollectionId;
  //       let parentPositionId = toPositionId(params.collateralToken, parentCollectionId);
  //       let parentUserPositionId = concat(params.stakeholder, parentPositionId) as Bytes;
  //       let parentPosition = UserPosition.load(parentUserPositionId.toHex());
  //       parentPosition.balance += params.amount;
  //       parentPosition.save();
  //   }
  // } else {
  //   // get the positionID of the union of indexsets
  //   let totalIndexSetCollectionId = add256(params.parentCollectionId, toCollectionId(params.conditionId, totalIndexSet));
  //     // maybe create a new Collection here
  //   let totalIndexSetPositionId = toPositionId(params.collateralToken, totalIndexSetCollectionId);
  //     // maybe create a new position here 
  //     let position = Position.load(/* union positionId */);
  //     if (position == null) {
  //       position = new Position(/* unionPositionId */))
  //         // get collectionId = (positionId - collateralToken)
  //           // let collection = create new Collection(/* collectionId */)
  //             // add Conditions to this collection
  //             // add indexSets to this collection
  //         )
  //       // position.collection = collectionId
  //       position.collateralToken = params.collateralToken;

  //     }
  //     position.save();
      
  //     // lower the balance of each partition position (these positions will already be in the system)
  //     for (var j=0; j< partition.length; j++) {
  //       let collectionId = add256(params.parentCollectionId, toCollectionId(params.conditionId, partition[i]));
  //       let positionId = toPositionId(params.collateralToken, collectionId);
  //       let userPositionId = concat(params.stakeholder, positionId) as Bytes;
  //       let userPosition = UserPosition.load(userPositionId.toHex());
  //       if (userPosition = null) {
  //         userPosition = new UserPosition(userPositionId.toHex());
  //         userPosition.user = params.stakeholder;
  //         userPosition.position = Position.load(positionId); // Position() should be created above          
  //       }
  //       userPosition.balance -= params.amount;
  //       userPosition.save();
  //     }
  //     let unionPositionId = toPositionId(params.collateralToken, toCollectionId(conditionId, totalIndexSet));
  //     let unionUserPositionId = concat(params.stakeholder, unionPositionId) as Bytes;
  //     let unionUserPosition = UserPosition.load(unionUserPositionId);
  //     if (UserPosition == null) {
  //       userUnionPositionId = new UserPosition(unionUserPositionId);
  //       userUnionPositionId.user = User.load(params.stakeholder.toHex());
  //       userUnionPositionId.position = Position.load(unionPositionId)
  //       if (userUnionPositionId.position == null) {
  //         let unionPosition = new Position(unionPositionId.toHex());
  //         unionPosition.collateralToken = params.collateralToken;  
  //         // create unionPosition Collections
  //       }
  //     }
  //   }
  // }
}

export function handlePayoutRedemption(event: PayoutRedemption): void {
  // stub
}

export function handleTransferSingle(event: TransferSingle): void {
  let params = event.params;
  // if you're doing a transfer the position should already be in the system
    // the UserPosition of the _from address should already be in the system
  let _fromUserPositionId = concat(params._from, bigIntToBytes32(params._id));
  let _fromUserPosition = UserPosition.load(_fromUserPositionId.toHex());
  _fromUserPosition.balance -= params._value;
  _fromUserPosition.save();

  // The _to UserPosition doesn't have to be in the system
  let _toUser = User.load(params._to.toHex());
  if (_toUser == null) {
    _toUser = new User(params._to.toHex());
  }
  let _toUserPositionId = concat(params._to, bigIntToBytes32(params._id)) as Bytes;
  let _toUserPosition = UserPosition.load(_toUserPositionId.toHex());
  if (_toUserPosition  == null) {
    _toUserPosition = new UserPosition(_toUserPositionId.toHex());
    _toUserPosition.user = _toUser.id;
    _toUserPosition.balance = 0;
    let position = Position.load(params._id.toHex());
    _toUserPosition.position = position.id;
  } 
  _toUserPosition.balance += params._value;
  _toUserPosition.save();
}

export function handleTransferBatch(event: TransferBatch): void {
  // let params = event.params;

  // for (var i=0; i < params._ids.length; i++) {
  //   // if you're doing a transfer the position should already be in the system
  //   // the UserPosition of the _from address should already be in the system
  //   let _fromUserPositionId = concat(params._from, bigIntToBytes32(params._id[i]));
  //   let _fromUserPosition = Position.load(_fromUserPositionId.toHex());
  //   _fromUserPosition.balance -= params._values[i];
  //   _fromUserPosition.save();

  //   // The _to UserPosition doesn't have to be in the system
  //   let _toUserPositionId = concat(params._to, params._id[i]);
  //   let _toUserPosition = UserPosition.load(_toUserPositionId.toHex());
  //   if (_toUserPosition  == null) {
  //     _toUserPosition = new UserPosition(_toUserPositionId.toHex());
  //     _toUserPosition.user = User.load(params._to.toHex());
  //     if (_toUserPosition.user == null) {
  //       _toUserPosition.user = new User(params._to.toHex());
  //     }
  //     _toUserPosition.position = Position.load(params._ids[i].toHex()).id;
  //     _toUserPosition.balance = 0;
  //   } 
  //   _toUserPosition.balance += params._values[i];
  //   _toUserPosition.save();
  // }
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