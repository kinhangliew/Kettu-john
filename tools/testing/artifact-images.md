# Artifact images acceptance tests

Use two actual computers. On host B, choose project P with a session from before the upgrade.
Create project Q on B and a project with the same name as P on A. Keep one ordinary HTML artifact
and one Markdown document artifact in P. Give each three visually distinct images:

- L is bundled at `images/local.png` from a file in B's working directory.
- T is a working PNG on `https://test-enabler.oss-cn-hongkong.aliyuncs.com`.
- U is a working PNG on a different HTTPS origin outside the default policy.

Before opening the artifacts, independently verify that the two HTTPS URLs return decodable images.
Use the same artifact ID and version per format across all four viewing paths. Start with A's
desktop artifact cache empty. Move B's source image after writing both versions and leave it
absent from A.

| Viewing path                          | HTML | Markdown |
| ------------------------------------- | ---- | -------- |
| Desktop on B                          | V01  | V02      |
| Web client on B connected to B        | V03  | V04      |
| Paired desktop on A connected to B    | V05  | V06      |
| Paired web client on A connected to B | V07  | V08      |

Run each cell in all three phases:

1. With no grant, open the card and reader. L decodes. T and U make no image request.
2. In the trusted project UI on B, grant T's origin once. Trigger a fresh image load in the
   same open frame and check that L and T decode. U makes no request. Repeat with the same
   artifact version reopened.
3. Revoke the grant on B while the previews are open. Trigger a fresh image load in the
   existing frame, then reopen the same version. T and U make no new request. L still decodes.
   Record card and reader separately if the card shows only a summary.

Record the host/client identities, artifact ID and version, image decode results, and request
evidence for each cell, including request counts observed at T and U. Remove signed query
parameters from the record. On each web path try an invalid or closed frame token while T is
granted. L is unavailable and the attempt sends zero new requests to T and U.

For V07 and V08 record the actual connection mode. Direct uses B's serving port and a live
frame token. Hosted or relay-only sessions can return `preview_only` when opening a frame.
Record that result and the available preview as a separate relay-only observation. A direct
run covers the direct connection alone. Count only tests on actual devices as two-computer
verification. Record missing prerequisites and count simulated protocol runs separately.

## Additional runtime checks

- **W03/W05** Try an image URL pointing to the filesystem and an HTML page with `base href`.
  No filesystem request occurs. The base does not permit an unauthorized HTTPS image.
- **W06/W08** Observe requests when saving the document. A mixed document can be saved before
  granting T. Invalid external references are refused without network traffic.
- **W09** Repeat the local image check with a second version with a visibly different L at the same
  path. With the original source moved, both versions still decode their own saved image.
- **P01** Check that the trusted confirmation names project P and limits consent to images. Cancel
  and check that neither the listed origins nor the image request state changes. Confirm and
  check that the origin is listed and T loads.
- **P02/P03** Approve T with a different path, query, uppercase host, and explicit port 443.
  Check for one canonical origin entry. Try the parent, sibling, child, lookalike and non-default
  port as image targets and confirm none are covered by T. Reject wildcard, non-HTTPS and malformed grants.
- **P04/P05** Restart B and open both P's old session and a new artifact in a new session. Both use
  the grant. Open the equivalent artifacts in Q and on A's identically named project. Neither
  issues a request for T.
- **P06** After revocation, trigger a new image load in an open page and repeat with a reopened
  historical version and a newly created card. Inspect requests in all three cases.
- **P07** Have T return a redirect to U. Confirm that T logs the initial request and U logs zero
  requests.
  Independently serve a 404, a non-image body, a timeout, and a corrupt image. In each case T fails
  or shows alt text and L still decodes.
- **P08** Use T as an image, script, stylesheet, font, media source, child frame and API endpoint.
  Only the image request gains permission. Check that page/agent operations cannot alter the grant.
- **P09** With T approved, open latest versions declaring `files` or `sample` and their earlier
  versions in desktop and web including a cold remote cache. L decodes and neither T nor an
  external CDN receives a request, starting at first load.
- **P10** With T still granted, disconnect A from B while the artifact stays open. Trigger a new
  image load without refreshing the frame. T and U each receive zero new requests. Verified
  cached bytes for L may still be displayed. Also try a legacy host, unresolved project or
  strict state, a missing image, and a transfer failure. Check that no new external permission
  is inferred and no file is substituted from another host, project or version.
- **P11** Simulate read and persistence failures. Confirm the trusted UI reports failure for
  lookup, grant and revoke. A client without a confirmed permission starts no external image requests.

## Release checks

| ID  | Check and expected result                                                                                                                                                                                                                                                                     |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R01 | Verify the official release is neither draft nor prerelease and its `v0.1.20` tag resolves to `03ce092924f98b8fa377897dfa800b2a8673ba3c`. Check ancestry of the delivery commit and trace the migrated 0.1.19 fix. Preserve new remote branch commits if any and stop if the tag differs.     |
| R02 | Compare the original worktree before and after. Both README edits, `tools.ts`, `guide/topics.ts` and the untracked `html-images.ts` retain their contents. The installer under `dist/windows-0.1.19-fork` retains SHA-256 `c930bdfb6b7bf76b94a6d49ecbed7fd56072d7b3c79e28a1e17e17530814631a`. |
| R03 | Check English and Chinese README, permission UI, document guidance, and agent create/update guidance. They agree on both image sources, mixing, project approval, revocation, strict isolation and cross-device prerequisites. Neither image source is presented as the agent's default.      |
| R04 | At the final commit, run `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test` and `pnpm build`. Record each exit result and any failure cause alongside the runtime results.                                                                                                       |
| R05 | Inspect the fork branch and its existing Windows workflow run. Confirm the x64 base installer and its verified checksum match v0.1.20, the installed-app replacement and data-directory marker checks pass, and the run produces a separately named installer and `SHA256SUMS.txt`.           |
| R06 | Download the successful run's outputs and verify the new installer's SHA-256 against the listing. Record branch, commit, run URL, installer name, size, digest, download location and actual V01–V08 results. A failed build, upgrade or checksum leaves the installer undelivered.           |
