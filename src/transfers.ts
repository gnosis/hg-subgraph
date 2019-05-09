import { BigInt, Bytes } from '@graphprotocol/graph-ts';

import {
  TransferSingle,
  TransferBatch
} from './types/PredictionMarketSystem/PredictionMarketSystem';

import {
  User,
  Position,
  UserPosition,
  Operator
} from './types/schema';

import { bigIntToBytes32, concat, checkIfValueExistsInArray, zeroAsBigInt, sum } from './utils'

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
  let _positionIds = params._ids;
  let _values = params._values;
  let copyPositionIds = new Array<BigInt>(params._ids.length);
  let copyValues = new Array<BigInt>(params._values.length);

  for (var i = 0; i < params._ids.length; i++) {
    copyPositionIds[i] = _positionIds[i];
    copyValues[i] = _values[i];

    let clonedPosition = Position.load(copyPositionIds[i].toHex());
    if (!Array.isArray(clonedPosition.conditions)) {
      clonedPosition.conditions = [];
    }

    let clonedPositionConditions = clonedPosition.conditions;
    for (var q = 0; q < clonedPositionConditions.length; q++) {
      if (
        !checkIfValueExistsInArray(
          _toUser.participatedConditions as String[],
          clonedPositionConditions[q]
        )
      ) {
        let _toUserParticipatedConditions = _toUser.participatedConditions;
        _toUserParticipatedConditions[_toUserParticipatedConditions.length] =
          clonedPositionConditions[q];
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
  if (!checkIfValueExistsInArray(operator.associatedAccounts as String[], params._to.toHex())) {
    clonedOperatorAssociatedAccounts[operator.associatedAccounts.length] = params._to.toHex();
  }
  if (!checkIfValueExistsInArray(operator.associatedAccounts as String[], params._from.toHex())) {
    clonedOperatorAssociatedAccounts[operator.associatedAccounts.length] = params._from.toHex();
  }
  operator.lastActive = event.block.timestamp;
  operator.associatedAccounts = clonedOperatorAssociatedAccounts;
  operator.save();
}
