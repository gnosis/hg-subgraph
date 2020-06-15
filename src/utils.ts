import { BigInt, ByteArray, Bytes } from '@graphprotocol/graph-ts';

export let zeroAsBigInt: BigInt = BigInt.fromI32(0);

export function sum(a: BigInt[]): BigInt {
  let result: BigInt = zeroAsBigInt;
  for (let i = 0; i < a.length; i++) {
    result = result.plus(a[i]);
  }
  return result;
}

export function bigIntToBytes32(bigInt: BigInt): Bytes {
  let sum = new Uint8Array(32) as Bytes;
  sum.fill(0);
  for (let i = 0; i < bigInt.length && i < 32; i++) {
    sum[31 - i] = bigInt[i];
  }
  return sum;
}

export function concat(a: ByteArray, b: ByteArray): ByteArray {
  let out = new Uint8Array(a.length + b.length);
  for (let i = 0; i < a.length; i++) {
    out[i] = a[i];
  }
  for (let j = 0; j < b.length; j++) {
    out[a.length + j] = b[j];
  }
  return out as ByteArray;
}
