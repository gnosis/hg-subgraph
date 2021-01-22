const fs = require('fs-extra');
const path = require('path');
const mustache = require('mustache');
const Web3 = require('web3');

const network = process.argv[2] || 'development';

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
  fs.readJsonSync(path.join('build', 'contracts', 'RealitioProxy.json')),
  fs.readJsonSync(path.join('build', 'contracts', 'RealitioScalarAdapter.json')),
];

const web3 = new Web3(
  Web3.givenProvider || network === 'development'
    ? 'http://localhost:8545'
    : network === 'xdai'
    ? 'https://rpc.xdaichain.com'
    : network === 'sokol'
    ? 'https://sokol.poa.network'
    : `https://${network}.infura.io/v3/d743990732244555a1a0e82d5ab90c7f`
);

const templateData = { network };

(async () => {
  const netId =
    network === 'mainnet'
      ? 1
      : network === 'rinkeby'
      ? 4
      : network === 'sokol'
      ? 77
      : network === 'xdai'
      ? 100
      : await web3.eth.net.getId();
  console.log(netId);

  for (const artifact of artifacts) {
    const { contractName } = artifact;
    console.log(contractName);

    if (artifact.networks == null || artifact.networks[netId] == null)
      throw new Error(`${contractName} not deployed on network ${netId}`);

    console.log(netId);
    const { address, transactionHash } = artifact.networks[netId];
    const { blockNumber } = await web3.eth.getTransactionReceipt(transactionHash);
    templateData[contractName] = {
      address,
      addressLowerCase: address.toLowerCase(),
      startBlock: blockNumber,
    };
  }

  for (const [basepath, ext] of [
    ['subgraph', 'yaml'],
    [path.join('src', 'conditions'), 'ts'],
    [path.join('src', 'wrappedtokens'), 'ts'],
    [path.join('src', 'realitio'), 'ts'],
  ]) {
    const template = fs.readFileSync(`${basepath}.template.${ext}`).toString();
    fs.writeFileSync(`${basepath}.${ext}`, mustache.render(template, templateData));
  }
})().catch((err) => {
  console.error(err);
  process.exit(-1);
});
