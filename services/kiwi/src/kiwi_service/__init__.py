"""Korean morphological analyzer service.

Wraps `kiwipiepy` (the Python binding to Kiwi) behind a small FastAPI app.
The service is stateless: input a Korean sentence, output lemmatized tokens
with POS tags and character offsets back to the original string. The Express
gateway (B3) calls this service when a user taps a Korean word.

See README.md for the API contract and DESIGN_SPEC.md (§The engine) for the
tap-a-word flow: Kiwi -> KRDICT -> Claude -> vocab bank.
"""

__version__ = "0.1.0"
