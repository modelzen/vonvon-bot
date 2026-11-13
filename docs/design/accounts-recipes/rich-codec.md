# Rich-v2 content codec

The shared protocol adds an explicit `rich-v2` variant. It does not change v1 manifests, serializers, proof purposes, generations, payloads, receipts, or historical quota bytes. No rich writer is enabled by this slice.

## Content and release identity

`RecipeRichContent` contains `format: "rich-v2"`, `schemaVersion: 2`, public text, selected portable items, immutable part descriptors, and an optional final Logo reference. Every public text field, role, setting, rule, skill, file, task, memory, setup step, Logo, and card block has an `itemId` and an `originId`. UUIDs must use lowercase. Item IDs are unique throughout one content document. Settings have a unique typed field key. Arrays preserve author order; omitted role and Logo stay absent, and empty selections stay empty.

`RecipeRichRelease` is a separate envelope with the recipe, exact version, author, revision, access, content digest, and logical byte count. Canonical content cannot contain its own version ID, content digest, or release envelope. `verifyRichRecipeRelease` checks the envelope against decoded canonical bytes. This does not check entitlement or distribution state.

Private drafts use the same field model and allow empty public values and unfinished setup text. `validatePublishableRichRecipeContent` requires nonblank name, summary, version, and the title and instructions of each selected setup step. `verifyRichRecipeRelease` enforces these requirements too. Publication checks do not alter canonical bytes or accounting.

`recipeRichAuthoringPayloadSchema` dispatches by explicit `purpose: "prepareDraft" | "editDraft"`. The format and purpose must match the caller's registered operation. The presence of a `schemaVersion` field never selects prepare or edit. This schema does not replace the v1 authoring dispatcher.

## Native settings and inert content

Settings use a strict union of native fields. The permitted fields are session mode, no-mention response, pending policy, presentation fields, model and model-access recommendations, speed and judge recommendations, and tier or native Codex and Claude permission requirements. Recommendations do not select an installed Provider. Requirements do not grant permissions. Unselected recommendations remain unspecified.

Model-access maps and lists are bounded. Claude domain allowlists are excluded. Codex and Claude native requirements contain only the known native scalar fields. Arbitrary custom settings, workspaces, credentials, identities, allowlists, hooks, execution history, and runtime receipts have no portable field.

Card blocks contain inert native display values and stable identities. They exclude `source`, `script`, `language`, `sample`, and arbitrary flow maps. The codec reconstructs a builtin-only native value to check the existing card semantics. Setup actions are either a manual acknowledgement or a named existing settings entry. A setup action is never a command. Local setup choices and observations are outside immutable content.

Safe file names are relative document names ending in `.md`, `.txt`, or `.rst`. Traversal, hidden directories, Windows reserved names, alternate data streams, backslashes, executable extensions, and names that collide under NFC and case folding within a skill are rejected. An entry must be a selected `SKILL.md` file with `use: "skillDescription"`. Every file belongs to a selected skill. The codec does not open files or establish filesystem confinement. These names are portable metadata, not authority to open or create that path. The native wrapper owner must generate confined paths and validate collisions on the actual target filesystem. It must generate inert native declarations rather than copy arbitrary source frontmatter, hooks, or plugin manifests into executable configuration.

## Canonical bytes and limits

`canonicalizeRichRecipeContent(unknown)` is the validation boundary. It checks strict shapes, the global item ID set, setting keys, skill membership, descriptor closure, text limits, and the logical byte budget. The exported Zod schemas describe individual wire shapes; shape parsing alone does not establish a valid package.

The serializer sorts object keys by JavaScript UTF-16 code units, retains array order, uses JSON string escaping, emits no whitespace, and encodes UTF-8 without a BOM. Author text is not Unicode-normalized. Unpaired surrogates and unsupported controls are rejected. JSON is bounded to 16 levels and 32,768 nodes. Input strings and canonical output are bounded before unbounded processing.

`decodeRichRecipeContent(string | Uint8Array)` rejects invalid UTF-8, a BOM, duplicate keys, noncanonical escapes, extra whitespace, excessive depth, invalid content, and alternate bytes. It compares the original input to the exact canonical serialization. `digestRichRecipeContent` returns the SHA-256 of those canonical content bytes.

For one version:

```text
B = canonicalUTF8.byteLength + sum(part.bytes for each distinct referenced objectId)
```

An inline body is counted only in canonical content. A referenced body is counted once by immutable object ID, even when several items use it. All declared descriptors must be referenced, every reference must resolve, and text and Logo kinds cannot be substituted. Descriptor JSON is part of canonical content. Transport base64, upload originals, server signatures, storage keys, and the release envelope are outside this formula.

The maximum is 1,048,576 bytes, inclusive. A text file and final Logo each allow 131,072 bytes. A memory allows 4,096 bytes, a rule and role each allow 16,384 bytes, and a task instruction allows 4,000 bytes. Public and setup readable text plus role total at most 32,768 decoded bytes. Setup instructions allow 2,048 bytes and checks allow 512 bytes. Counts are 16 skills, 64 files, 32 rules, 32 tasks, 64 memories, and eight setup steps.

The fixture `packages/protocol/test/fixtures/recipe-rich-v2.golden.json` contains exact canonical text, UTF-8 hex, byte counts, and a SHA-256 independently generated with Python's UTF-8 JSON serializer. The protocol tests run the same fixture on each platform. The fixture includes composed and decomposed Unicode, a joined emoji, quotes, backslashes, tabs, newlines, and repeated references. Separate tests cover every item count and exact byte boundaries.

## Verification and provenance authority

`RecipeRichPartDescriptor` contains only `objectId`, kind, SHA-256, verified byte count, and media type. It has no local path, object-storage key, upload ticket, or client-set verification flag. The private broker must verify actual immutable stored bytes before the service accepts these descriptors. The codec verifies descriptor consistency and accounting; it cannot verify storage bytes or mint a ready receipt.

`RecipeRichOriginRecord` describes the cloud-owned immutable record behind an `originId`. Its edges name the exact source version, item, and baseline digest. Shape parsing does not establish authorship, account ownership, trusted source membership, redistribution permission, or graph closure. The authenticated cloud acceptance and publication transactions must resolve the handles against retained source manifests and check those conditions. Edits retain the same item identity and immutable origin. Copies receive a fresh item identity and a new authority-issued origin record retaining the donor edges.

The codec cannot detect arbitrary manual rewriting, validate local file handles, isolate runtime packages, pause tasks, enforce old-binary compatibility, or authorize object access. Those remain owning service and runtime gates.
