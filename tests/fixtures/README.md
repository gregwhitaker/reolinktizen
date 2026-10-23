These certificates and their private key are disposable fixtures for loopback-only HTTPS integration tests. They do not belong to a recorder, user, or deployed service. Never use them outside tests.

`tls-expired-cert.txt` is a public PEM certificate generated with the same disposable key and an expired validity period. The certificate tests use in-memory TLS streams, with no network listeners, to exercise self-signed, changed and expired certificates.
