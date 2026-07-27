#!/usr/bin/env node
import { readConfig } from "./configStore.js";
import { checkProviderHealth } from "./smartRoute/providerCheck.js";

const config = await readConfig();
const health = await checkProviderHealth(config);
console.log(JSON.stringify(health, null, 2));
