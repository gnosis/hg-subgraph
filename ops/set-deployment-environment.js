const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
require('dotenv').config();

/**
 * Fetch all abis from @daostack/arc into the `abis` folder.
 */
async function setDeploymentEnvironment() {
  // Get document, or throw exception on error
  try {
    var args = process.argv.slice(2);
    let network = args[0];
    let address = args[1];
    let file = require('path').join('subgraph.yaml');
    let doc = yaml.safeLoad(fs.readFileSync(file));
    console.log(doc['dataSources'][0].source);

    doc['dataSources'][0].network = network || process.env.NETWORK;
    doc['dataSources'][0].source.address = address || process.env.ADDRESS;
    // console.log(doc);
    // if (network == 'development') {
    //   doc['services']['ganache'] = {
    //     image:
    //       'daostack/migration:' + require('../package.json').devDependencies['@daostack/migration'],
    //     ports: ['8545:8545']
    //   };

    //   doc['services']['graph-node']['links'] = ['ipfs', 'postgres', 'ganache'];
    // } else {
    //   delete doc['services']['ganache'];
    //   doc['services']['graph-node']['links'] = ['ipfs', 'postgres'];
    // }
    // doc['services']['graph-node']['environment']['postgres_pass'] = postgresPassword;
    // doc['services']['postgres']['environment']['POSTGRES_PASSWORD'] = postgresPassword;
    // doc['services']['graph-node']['environment']['ethereum'] = `${network}:${ethereumNode}`;
    fs.writeFileSync(path.join(file), yaml.safeDump(doc), 'utf-8');
  } catch (msg) {
    throw Error(`Setting docker network failed! ${msg}`);
  }
}

if (require.main === module) {
  setDeploymentEnvironment().catch(err => {
    console.log(err);
    process.exit(1);
  });
} else {
  module.exports = setDeploymentEnvironment;
}
