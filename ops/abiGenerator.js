const fs = require('fs-extra');
const path = require('path');

const contractName = 'ConditionalTokens';
const { abi } = fs.readJsonSync(
  path.join(
    'node_modules',
    '@gnosis.pm',
    'conditional-tokens-contracts',
    'build',
    'contracts',
    `${contractName}.json`
  )
);
fs.outputJsonSync(path.join('abis', `${contractName}.json`), abi, { spaces: 2 });
