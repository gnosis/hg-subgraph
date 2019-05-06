FROM node

USER root

RUN npm i -g ganache-cli

ENV VERSION=v10.13.0 NPM_VERSION=6 YARN_VERSION=latest DOCKER=true

EXPOSE 8545

CMD ganache-cli -d 

