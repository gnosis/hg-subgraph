import {BigInt, Bytes } from '@graphprotocol/graph-ts'
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
  condition.payoutNumerators = []
  condition.payoutDenominator = 0
  condition.totalValue = 0
  condition.save()
}

export function handleConditionResolution(event: ConditionResolution): void {
  let condition = Condition.load(event.params.conditionId.toHex())
  condition.payoutNumerators = event.params.payoutNumerators
  let deonominator: BigInt = add(event.params.payoutNumerators)
  condition.payoutDenominator = deonominator
  condition.resolveTransaction = event.transaction.hash
  condition.resolveTimestamp = event.block.timestamp
  condition.resolved = true;
  condition.save()
}



export function handlePositionSplit(event: PositionSplit): void {
    let contract = PredictionMarketSystem.bind(event.address)

    for (let i=0; i<event.params.partition.length; i++) {
 
      let collectionId = contract.getCollectionId(event.params.parentCollectionId, event.params.conditionId, getPartition(event.params.partition, i));
      let collection = Collection.load(collectionId.toHex())
      if (collection == null) {
        collection = new Collection(collectionId.toHex())
      }
      collection.totalValue += event.params.amount
      collection.save()
      
      let positionId = contract.getPositionId(event.params.collateralToken, collectionId);
      let position = Position.load(positionId.toHex())
      if (position == null) {
        position = new Position(positionId.toHex())
      }
      position.stakeholder = event.params.stakeholder
      position.collateralToken = event.params.collateralToken
      position.parentCollectionId = event.params.parentCollectionId
      position.conditionId = event.params.conditionId.toHex()
      position.amount += event.params.amount
      position.save()
    }


    let condition = Condition.load(event.params.conditionId.toHex())
    condition.totalValue += event.params.amount
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
    collection.totalValue += event.params.amount
    collection.save()
    
    let positionId = contract.getPositionId(event.params.collateralToken, collectionId);
    let position = Position.load(positionId.toHex())
    if (position == null) {
      position = new Position(positionId.toHex())
    }
    position.stakeholder = event.params.stakeholder
    position.collateralToken = event.params.collateralToken
    position.parentCollectionId = event.params.parentCollectionId
    position.conditionId = event.params.conditionId.toHex()
    position.amount += event.params.amount
    position.save()
  }

  let condition = Condition.load(event.params.conditionId.toHex())
  condition.totalValue -= event.params.amount
  condition.save()

}


// Helper functions (mandated by AssemblyScript for memory issues)
function add(a: BigInt[]): BigInt {
  let out = new Array<BigInt>(a.length)
  let result: BigInt = 0;
  for (let i = 0; i < a.length; i++) {
    out[i] = a[i]
    result = result + out[i]
  }
  return result;
}

function getPartition(partitions: BigInt[], index: i32): BigInt {
  let result: BigInt = partitions[index];
  return result;
}

function getPosition(collateralToken: Bytes, collection: Bytes): Bytes {
  let output: Bytes = collateralToken + collection
  return output
}