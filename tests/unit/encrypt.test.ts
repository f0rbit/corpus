import { describe, test, expect, beforeAll } from "bun:test";
import { encrypt_codec } from "../../codecs/encrypt";
import { compose, text_codec } from "../../utils";

const make_key = () => crypto.subtle.generateKey(
	{ name: "AES-GCM", length: 256 },
	true,
	["encrypt", "decrypt"],
);

describe("encrypt_codec", () => {
	let key: CryptoKey;

	beforeAll(async () => {
		key = await make_key();
	});

	test("encode/decode roundtrip preserves bytes", async () => {
		const codec = encrypt_codec(key);
		const plaintext = new TextEncoder().encode("hello encrypted world");
		const encoded = await codec.encode(plaintext);
		const decoded = await codec.decode(encoded);
		expect(decoded).toEqual(plaintext);
	});

	test("same plaintext encoded twice produces different ciphertexts (random IV)", async () => {
		const codec = encrypt_codec(key);
		const plaintext = new TextEncoder().encode("static plaintext");
		const a = await codec.encode(plaintext);
		const b = await codec.encode(plaintext);
		expect(a).not.toEqual(b);
	});

	test("decode with wrong key fails", async () => {
		const codec = encrypt_codec(key);
		const other_key = await make_key();
		const wrong = encrypt_codec(other_key);

		const plaintext = new TextEncoder().encode("secret");
		const ciphertext = await codec.encode(plaintext);

		expect(wrong.decode(ciphertext)).rejects.toThrow();
	});

	test("tampered ciphertext fails to decrypt (auth-tag verification)", async () => {
		const codec = encrypt_codec(key);
		const plaintext = new TextEncoder().encode("integrity check");
		const ciphertext = await codec.encode(plaintext);

		// Flip a byte well inside the ciphertext (past the 12-byte IV).
		const tampered = new Uint8Array(ciphertext);
		const flip_at = 16;
		tampered[flip_at] = (tampered[flip_at]! ^ 0x01);

		expect(codec.decode(tampered)).rejects.toThrow();
	});

	test("compose(text_codec, encrypt_codec).decode_stream is undefined (encrypt has no decode_stream)", () => {
		const codec = compose(text_codec(), encrypt_codec(key));
		expect(codec.decode_stream).toBeUndefined();
	});

	test("compose(text_codec, encrypt_codec).encode_stream is defined (encrypt does have encode_stream)", () => {
		const codec = compose(text_codec(), encrypt_codec(key));
		expect(typeof codec.encode_stream).toBe("function");
	});
});
