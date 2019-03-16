import {BigInt, Bytes, crypto } from '@graphprotocol/graph-ts'
import { ConditionPreparation, ConditionResolution, PositionSplit } from './types/PredictionMarketSystem/PredictionMarketSystem'
import { Condition, Position } from './types/schema'

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
  condition.payoutNumerators = []
  condition.payoutDenominator = 0
  condition.save()
}

export function handleConditionResolution(event: ConditionResolution): void {
  let condition = Condition.load(event.params.conditionId.toHex())
  condition.payoutNumerators = event.params.payoutNumerators
  let deonominator: BigInt = concat(event.params.payoutNumerators)
  condition.payoutDenominator = deonominator
  condition.resolveTransaction = event.transaction.hash
  condition.resolveTimestamp = event.block.timestamp
  condition.resolved = true;
  condition.save()
}

function concat(a: BigInt[]): BigInt {
  let out = new Array<BigInt>(a.length)
  let result: BigInt = 0;
  for (let i = 0; i < a.length; i++) {
    out[i] = a[i]
    result = result + out[i]
  }
  return result;
}

// export function handlePositionSplit(event: PositionSplit): void {
//   let indexSetArr = new Array<BigInt>(event.params.partition.length);
  
//   for (let i=0; i< indexSetArr.length; i++) {
//     // let position = new Position(indexSetArr[i].toHex());
//     let condition = event.params.conditionId
//     let collateral = event.params.collateralToken
//     let parentCollection = event.params.parentCollectionId

//     getCollectionId(parentCollection, condition, indexSetArr[i])
//   }
// }

// function getCollectionId(parentCollectionId: Bytes, _conditionId: Bytes, _indexSet: BigInt): Bytes {
//   let condition = _conditionId
//   let indexSet = _indexSet
//   let bytesArray: BigInt = condition + indexSet.toHex()
//   // let uint2: BigInt = crypto.keccak256()
//   return parentCollectionId
// }