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
  let params = event.params
  let partition = params.partition

  for (let i=0; i<partition.length; i++) {
    let collectionId = add256(params.parentCollectionId, toCollectionId(params.conditionId, partition[i]))
    let collection = Collection.load(collectionId.toHex())
    if (collection == null) {
      collection = new Collection(collectionId.toHex())
      collection.save()
    }
    
    let positionId = toPositionId(params.collateralToken, collectionId)
    let position = Position.load(positionId.toHex())
    if (position == null) {
      position = new Position(positionId.toHex())
      position.collateralToken = params.collateralToken
      position.save()
    }
  }
}

export function handlePositionsMerge(event: PositionsMerge): void {
  // stub
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
  let sum = new Uint8Array(32) as Bytes
  for(let i = 0; i < sumBigInt.length && i < 32; i++) {
    sum[31 - i] = sumBigInt[i]
  }

  return sum
}
