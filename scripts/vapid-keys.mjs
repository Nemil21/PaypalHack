#!/usr/bin/env node
// HF-054b: generate a VAPID key pair for web push. Run once, paste both lines into .env (local)
// and the Render dashboard (holdfast web service). Keep VAPID_PRIVATE_KEY secret; never commit it.
// Changing the pair later invalidates every stored browser subscription (users re-enable alerts).
import { generateVAPIDKeys } from 'web-push';

const { publicKey, privateKey } = generateVAPIDKeys();
process.stdout.write(`VAPID_PUBLIC_KEY=${publicKey}\nVAPID_PRIVATE_KEY=${privateKey}\n`);
