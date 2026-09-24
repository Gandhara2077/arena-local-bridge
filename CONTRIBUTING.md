# Contributing

Thanks for considering a contribution.

## Before opening a change

- Keep the project focused on the local Arena-to-OpenAI-compatible bridge.
- Do not add credentials, cookies, private account data, or runtime artifacts.
- Do not add third-party code or assets without confirming their license and provenance.
- Prefer small, reviewable changes.

## Tests

Run the complete test suite before submitting a pull request:

~~~bash
npm install
npm test
~~~

Changes to authentication, session handling, request parsing, credential storage or security-sensitive code should include regression tests where practical.

## Documentation

User-facing behavior changes should update the README or the relevant documentation. Clearly distinguish documented Arena behavior from reverse-engineered or implementation-dependent behavior.

## Pull requests

Describe:

1. what changed;
2. why it changed;
3. how it was tested;
4. any compatibility or security implications.