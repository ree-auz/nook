#!/usr/bin/env node
// @ts-check
import { main } from "../integrations/linear/nkl.mjs";

process.exitCode = await main(process.argv.slice(2));
