const delay = require('delay');
const fetch = require('node-fetch');
const { ApolloClient, InMemoryCache, HttpLink, gql } = require('apollo-boost');

const graphClient = new ApolloClient({
  link: new HttpLink({
    uri: 'http://localhost:8000/subgraphs',
    fetch,
  }),
  cache: new InMemoryCache(),
  defaultOptions: {
    query: {
      fetchPolicy: 'no-cache',
      errorPolicy: 'all',
    },
  },
});

const subgraphClient = new ApolloClient({
  link: new HttpLink({
    uri: 'http://localhost:8000/subgraphs/name/gnosis/hg',
    fetch,
  }),
  cache: new InMemoryCache(),
  defaultOptions: {
    query: {
      fetchPolicy: 'no-cache',
      errorPolicy: 'all',
    },
  },
});

module.exports = function ({ web3 }) {
  async function waitForGraphSync(targetBlockNumber) {
    if (targetBlockNumber == null) targetBlockNumber = await web3.eth.getBlockNumber();

    do {
      await delay(100);
    } while (
      (
        await graphClient.query({
          query: gql`
            {
              subgraphVersions(orderBy: createdAt, orderDirection: desc, first: 1) {
                deployment {
                  latestEthereumBlockNumber
                }
              }
            }
          `,
        })
      ).data.subgraphVersions[0].deployment.latestEthereumBlockNumber < targetBlockNumber
    );
  }

  return {
    waitForGraphSync,
    graphClient,
    subgraphClient,
  };
};
