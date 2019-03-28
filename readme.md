# Prediction Markets Subgraph
This is a work in progress and is going to be the Subgraph for Gnosis Prediction Markets 2.0 


Here is the subgraph deployed
[Subgraph](https://thegraph.com/explorer/subgraph/infinitestyles/pm)

## Local deployment instructions

1.  Start up Ganache CLI in deterministic mode listening at 0.0.0.0:

        npx ganache-cli -d -h 0.0.0.0

2.  Start the Graph docker:

        cd path/to/graphprotocol/graph-node/docker
        docker-compose up

    (Linux users will have to edit the docker-compose.yml to point to the virtual address of the host in order for container to connect with Ganache)

3.  Run a migration script:

        npm run migrate

4.  Put ABI into right place:

        npm run refresh-abi

5.  Create and deploy subgraph:

        npm run create-local
        npm run deploy-local
