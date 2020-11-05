const fs = require('fs-extra');
const path = require('path');

const artifacts = [
  fs.readJsonSync(
    path.join(
      'node_modules',
      '@gnosis.pm',
      'conditional-tokens-contracts',
      'build',
      'contracts',
      'ConditionalTokens.json'
    )
  ),
  fs.readJsonSync(
    path.join('node_modules', '1155-to-20', 'build', 'contracts', 'Wrapped1155Factory.json')
  ),
  fs.readJsonSync(
    path.join('node_modules', '1155-to-20', 'build', 'contracts', 'Wrapped1155.json')
  ),
  fs.readJsonSync(
    path.join(
      'node_modules',
      '@realitio',
      'realitio-contracts',
      'truffle',
      'build',
      'contracts',
      'Realitio.json'
    )
  ),
  fs.readJsonSync(path.join('build', 'contracts', 'RealitioScalarAdapter.json')),
];

for (const { contractName, abi } of artifacts)
  fs.outputJsonSync(path.join('abis', `${contractName}.json`), abi, { spaces: 2 });
