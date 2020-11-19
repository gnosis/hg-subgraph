import { log, BigInt, ByteArray, Bytes, Address } from '@graphprotocol/graph-ts';
import { Global, User } from '../generated/schema';

export let zeroAsBigInt: BigInt = BigInt.fromI32(0);
export let zeroAddress: Address = Address.fromString('0x0000000000000000000000000000000000000000');

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

export function touchUser(userAddress: Address, blockTimestamp: BigInt): User {
  let userAddressHex = userAddress.toHexString();
  let user = User.load(userAddressHex);
  if (user == null) {
    user = new User(userAddressHex);
    user.firstParticipation = blockTimestamp;
  }
  user.lastActive = blockTimestamp;
  user.save();

  return user as User;
}

enum UnescapeState {
  Normal,
  Escaped,
  ReadingHex1,
  ReadingHex2,
  ReadingHex3,
  ReadingHex4,
}

export function unescape(input: string): string {
  let output = '';
  let i = 0;
  let state = UnescapeState.Normal;
  let escapedCodeUnitBuffer = 0;
  for (let i = 0; i < input.length; i++) {
    let codeUnit = input.charCodeAt(i);

    if (state == UnescapeState.Normal) {
      if (codeUnit == 0x5c) {
        // \
        state = UnescapeState.Escaped
      } else {
        output += String.fromCharCode(codeUnit);
      }
    } else if (state == UnescapeState.Escaped) {
      if (codeUnit == 0x75) {
        // %x75 4HEXDIG )  ; uXXXX                U+XXXX
        state = UnescapeState.ReadingHex1;
      } else {
        if (codeUnit == 0x62) {
          // %x62 /          ; b    backspace       U+0008
          output += '\b';
        } else if (codeUnit == 0x66) {
          // %x66 /          ; f    form feed       U+000C
          output += '\f';
        } else if (codeUnit == 0x6e) {
          // %x6E /          ; n    line feed       U+000A
          output += '\n';
        } else if (codeUnit == 0x72) {
          // %x72 /          ; r    carriage return U+000D
          output += '\r';
        } else if (codeUnit == 0x74) {
          // %x74 /          ; t    tab             U+0009
          output += '\t';
        } else if (
          codeUnit == 0x22 ||
          codeUnit == 0x5c || 
          codeUnit == 0x2f
        ) {
          output += String.fromCharCode(codeUnit);
        } else {
          let badEscCode = String.fromCharCode(codeUnit);
          log.warning('got invalid escape code \\{} in position {} while unescaping "{}"', [
            badEscCode,
            i.toString(),
            input,
          ]);
          output += '�';
        }
        state = UnescapeState.Normal;
      }
    } else {
      // reading hex characters here
      let nibble = 0;
      if (codeUnit >= 48 && codeUnit < 58) {
        // 0-9
        nibble = codeUnit - 48;
      } else if (codeUnit >= 65 && codeUnit < 71) {
        // A-F
        nibble = codeUnit - 55;
      } else if (codeUnit >= 97 && codeUnit < 103) {
        // a-f
        nibble = codeUnit - 87;
      } else {
        nibble = -1;
      }
      
      if (nibble < 0) {
        log.warning('got invalid hex character {} in position {} while unescaping "{}"', [
          String.fromCharCode(codeUnit),
          i.toString(),
          input,
        ]);
        output += '�';
        state = UnescapeState.Normal;
      } else {
        if (state == UnescapeState.ReadingHex1) {
          escapedCodeUnitBuffer |= nibble << 12;
          state = UnescapeState.ReadingHex2;
        } else if (state == UnescapeState.ReadingHex2) {
          escapedCodeUnitBuffer |= nibble << 8;
          state = UnescapeState.ReadingHex3;
        } else if (state == UnescapeState.ReadingHex3) {
          escapedCodeUnitBuffer |= nibble << 4;
          state = UnescapeState.ReadingHex4;
        } else if (state == UnescapeState.ReadingHex4) {
          output += String.fromCharCode(escapedCodeUnitBuffer | nibble);
          escapedCodeUnitBuffer = 0;
          state = UnescapeState.Normal;
        }
      }
    }
  }

  return output;
}

export function requireGlobal(): Global {
  let global = Global.load('');
  if (global == null) {
    global = new Global('');
    global.numConditions = 0;
    global.numCollections = 0;
    global.numPositions = 0;
  }
  return global as Global;
}
