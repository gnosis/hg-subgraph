const delay = require('delay');
const axios = require('axios');

module.exports = function ({ web3 }) {
  async function waitForGraphSync(targetBlockNumber) {
    if (targetBlockNumber == null) targetBlockNumber = await web3.eth.getBlockNumber();

    do {
      await delay(100);
    } while (
      (
        await axios.post('http://localhost:8000/subgraphs', {
          query:
            '{subgraphVersions(orderBy:createdAt orderDirection:desc first:1){deployment{latestEthereumBlockNumber}}}',
        })
      ).data.data.subgraphVersions[0].deployment.latestEthereumBlockNumber < targetBlockNumber
    );
  }

  return { waitForGraphSync };
};
