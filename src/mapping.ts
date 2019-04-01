import { crypto, Address, BigInt, Bytes } from '@graphprotocol/graph-ts'
import { ConditionPreparation, ConditionResolution, PositionSplit, PositionsMerge, PredictionMarketSystem } from './types/PredictionMarketSystem/PredictionMarketSystem'
import { Condition, Collection, Position } from './types/schema'

export function handleConditionPreparation(event: ConditionPreparation): void {
  let condition = new Condition(event.params.conditionId.toHex())
  condition.creator = event.transaction.from
  condition.oracle = event.params.oracle
  condition.questionId = event.params.questionId
  condition.outcomeSlotCount = event.params.outcomeSlotCount
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
    let contract = PredictionMarketSystem.bind(event.address)

    let params = event.params
    let partition = params.partition

    for (let i=0; i<partition.length; i++) {
      let collectionId = contract.getCollectionId(params.parentCollectionId, params.conditionId, partition[i]);
      let collection = Collection.load(collectionId.toHex())
      if (collection == null) {
        collection = new Collection(collectionId.toHex())
      }
      collection.testValue = toCollectionId(params.conditionId, partition[i]);
      collection.save()
      
      let positionId = contract.getPositionId(params.collateralToken, collectionId);
      let position = Position.load(positionId.toHex())
      if (position == null) {
        position = new Position(positionId.toHex())
      }
      position.testValue = toPositionId(params.collateralToken, collectionId)
      position.collateralToken = params.collateralToken
      position.save()
    }

    let condition = Condition.load(params.conditionId.toHex())
    condition.save()
}

export function handlePositionsMerge(event: PositionsMerge): void {
  let contract = PredictionMarketSystem.bind(event.address)

  for (let i=0; i<event.params.partition.length; i++) {
 
    let collectionId = contract.getCollectionId(event.params.parentCollectionId, event.params.conditionId, getPartition(event.params.partition, i));
    let collection = Collection.load(collectionId.toHex())
    if (collection == null) {
      collection = new Collection(collectionId.toHex())
    }
    collection.save()
    
    let positionId = contract.getPositionId(event.params.collateralToken, collectionId);
    let position = Position.load(positionId.toHex())
    if (position == null) {
      position = new Position(positionId.toHex())
    }
    position.collateralToken = event.params.collateralToken
    position.save()
  }

  let condition = Condition.load(event.params.conditionId.toHex())
  condition.save()
}

// Helper functions (mandated by AssemblyScript for memory issues)
function sum(a: BigInt[]): BigInt {
  let result: BigInt = 0;
  for (let i = 0; i < a.length; i++) {
    result = result + a[i]
  }
  return result;
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

function getPartition(partitions: BigInt[], index: i32): BigInt {
  let result: BigInt = partitions[index];
  return result;
}

function getPosition(collateralToken: Bytes, collection: Bytes): Bytes {
  let output: Bytes = collateralToken + collection
  return output
}