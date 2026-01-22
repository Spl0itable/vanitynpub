# Vanity Npub

A browser-based Nostr vanity public key miner. Generate custom Nostr identities with your desired prefix, suffix, or pattern entirely in your browser with the keys never leaving your device.

## Features

- Fully client-side key generation using Web Workers
- Multi-threaded mining utilizing multiple CPU cores
- Different pattern matching (prefix, suffix, or contains)

## How It Works

### Mining Algorithm

The miner generates random Nostr keypairs using `@noble/secp256k1` and checks if the bech32-encoded npub matches your desired pattern.

**Difficulty Scaling:**

| Length | Expected Attempts | Time (8 threads) |
|--------|-------------------|------------------|
| 1 char | ~16 | Instant |
| 2 chars | ~512 | < 1 second |
| 3 chars | ~16K | A few seconds |
| 4 chars | ~500K | 1-2 minutes |
| 5 chars | ~16M | 30+ minutes |
| 6 chars | ~500M | Hours |
| 7+ chars | 16B+ | Days/weeks |

### Valid Characters

Bech32 encoding uses these characters (excludes 1, b, i, o):
```
qpzry9x8gf2tvdw0s3jn54khce6mua7l
```

### Security

- Keys generated using `@noble/secp256k1` via `nostr-tools`
- Cryptographically secure random number generation
- All computation in isolated Web Workers
- No network transmission of keys
- Private keys never leave your device

## Usage

1. Enter your desired pattern after "npub1"
2. Choose position: starts with, contains, or ends with
3. Adjust thread count for optimal performance
4. Click "Start Mining" to begin
5. The tool will find 3 matching variations
6. Copy and securely store your private key (nsec)

## Support

This project is free to use. If you find it useful, consider sending a Lightning tip:

- Lightning Address: `69420@wallet.yakihonne.com`
- Nostr: `npub16jd6qg3zrkdpk0yvxqmt9803ysmc3d9c3ct5x9vkqlt0kxgs02lsj2lr3d`

Tips are voluntary and help support continued development.

## Contributing

Contributions are welcome. To contribute:

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Commit with clear messages
5. Push to your fork
6. Open a Pull Request

## License

MIT License - see LICENSE file for details.