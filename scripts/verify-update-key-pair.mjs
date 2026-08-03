import { verifyUpdateKeyPair } from './generate-update-metadata.mjs';

// A beta never signs update metadata, so a mismatched key pair would otherwise
// stay hidden until the first stable release tried to publish `latest.json`.
verifyUpdateKeyPair(process.env);
console.log('update signing key pair matches the embedded public key');
