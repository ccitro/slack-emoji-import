#!/bin/bash

echo "After docker bash loads, run these, then follow the prompts:"
echo "cd /home/node/app/"
echo "yarn"
echo "node index.js data/dc/"

sudo docker run --name emoji --rm -it -v $PWD:/home/node/app ccitro/node-chrome-headless /bin/bash
