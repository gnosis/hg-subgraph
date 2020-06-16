const fs = require('fs-extra');
const path = require('path');
const mustache = require('mustache');
const Web3 = require('web3');

const network = process.argv[2] || 'development';

const artifact = fs.readJsonSync(
  path.join(
    'node_modules',
    '@gnosis.pm',
    'conditional-tokens-contracts',
    'build',
    'contracts',
    'ConditionalTokens.json'
  )
);
const web3 = new Web3(
  Web3.givenProvider || network === 'development'
    ? 'http://localhost:8545'
    : `https://${network}.infura.io/v3/d743990732244555a1a0e82d5ab90c7f`
);

const templateData = { network };

(async () => {
  const netId = network === 'mainnet' ? 1 : network === 'rinkeby' ? 4 : await web3.eth.net.getId();

  if (artifact.networks == null || artifact.networks[netId] == null)
    throw new Error(`Not deployed on network ${netId}`);

  const { address, transactionHash } = artifact.networks[netId];
  const { blockNumber } = await web3.eth.getTransactionReceipt(transactionHash);
  templateData.ConditionalTokens = {
    address,
    startBlock: blockNumber,
  };

  const template = fs.readFileSync('subgraph.template.yaml').toString();
  fs.writeFileSync('subgraph.yaml', mustache.render(template, templateData));
})().catch((err) => {
  console.error(err);
  process.exit(-1);
});
