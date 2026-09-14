# P1 core changes — exact edits to syllabai-core @ 4b64aba (main)

Apply AFTER copying new-files/ into place. Anchors verified against 4b64aba
working tree during the first rehearsal run (all 355 unit tests passed with
these applied).

## 1. new-files → destinations

| file | destination under repos/syllabai-core |
|---|---|
| V19__bootstrap_admin_state.sql | src/main/resources/db/migration/ |
| BootstrapStateStore.java       | src/main/java/com/syllabai/identity/ |
| BootstrapAdminService.java     | src/main/java/com/syllabai/identity/ |
| BootstrapAdminController.java  | src/main/java/com/syllabai/identity/ |
| BootstrapAdminServiceTest.java | src/test/java/com/syllabai/identity/ (mkdir) |

## 2. SecurityConfig.java — permit the bootstrap surface

In `src/main/java/com/syllabai/identity/SecurityConfig.java`, replace:

```java
                        .requestMatchers(
                                "/api/v1/auth/register",
                                "/api/v1/auth/login").permitAll()
```

with:

```java
                        .requestMatchers(
                                "/api/v1/auth/register",
                                "/api/v1/auth/login",
                                // one-time first-admin bootstrap (V19): gated by the
                                // bootstrap_admin_state row + zero-admins invariant
                                "/api/v1/auth/bootstrap-status",
                                "/api/v1/auth/bootstrap-admin").permitAll()
```

## 3. AssessmentService.java — serving boundary at the attempt path

`src/main/java/com/syllabai/assessment/AssessmentService.java`:

3a. Add field (after `private final EvidencePublisher evidencePublisher;`):

```java
    private final ServableQuestionSpec servable = new ServableQuestionSpec();
```

3b. In `submit(...)`, after the question load + `.orElseThrow(NotFoundException "question")`
and BEFORE `QuestionOption chosen = ...`, insert:

```java
        // serving boundary at the write path too (§7: unvalidated content never
        // serves — not even as an attempt target): a STRUCTURED question is only
        // attemptable while its current version is VALIDATED. Fail-closed 404,
        // no state echo.
        if (question.type() == Question.Type.STRUCTURED) {
            QuestionVersion current = questionVersions
                    .findByQuestionIdOrderByVersionDesc(question.id()).stream()
                    .findFirst().orElse(null);
            if (!servable.isSatisfiedBy(question, current)) {
                throw new NotFoundException("question", request.questionId());
            }
        }
```

3c. In `submitStructured(...)`, after the version load and BEFORE
`List<QuestionPart> parts = version.parts();`, insert:

```java
        // serving boundary at the write path: only a VALIDATED current version is
        // attemptable (paper detail exposes ids to any authenticated user, so the
        // unvalidated gate must live HERE, not only on the read endpoints).
        // Fail-closed 404 — no part labels, no marks, no state echo.
        if (!servable.isSatisfiedBy(question, version)) {
            throw new NotFoundException("structured question", request.questionId());
        }
```

## 4. ExamPaperRepository.java — subject-scoped listing

Add after `List<ExamPaper> findAllByOrderByCreatedAtDesc();`:

```java
    List<ExamPaper> findAllBySubjectIdOrderByCreatedAtDesc(UUID subjectId);
```

## 5. QuestionRepository.java — paper-scoped questions

Add before the closing brace:

```java
    /** questions of one exam paper, difficulty-ordered (paper detail view) */
    @EntityGraph(attributePaths = "options")
    List<Question> findAllByExamPaperIdOrderByDifficultyAsc(UUID examPaperId);
```

## 6. ExamPaperController.java — use the derived queries (perf: no full scans)

Replace `list(...)` body expression:

```java
        return (subjectId == null
                ? examPapers.findAllByOrderByCreatedAtDesc()
                : examPapers.findAllBySubjectIdOrderByCreatedAtDesc(subjectId))
                .stream().map(PaperView::from).toList();
```

and in `get(...)` replace the question fetch:

```java
        List<Question> paperQuestions =
                questions.findAllByExamPaperIdOrderByDifficultyAsc(id);
```

## 7. AssessmentServiceTest.java — boundary tests

Imports: add `import static org.mockito.Mockito.never;` and
`import static org.mockito.Mockito.verify;`.

Append before the final closing brace (uses existing helpers `structuredQuestion()`,
`submit(...)`; construction pattern matches `structuredSubmitRejectsMissingPart`):

```java
    @Test
    @DisplayName("structured submit is refused for a SUGGESTED (unvalidated) version — fail-closed")
    void structuredSubmitRefusesUnvalidated() {
        Question question = structuredQuestion();
        when(questions.findById(QUESTION_ID)).thenReturn(Optional.of(question));
        QuestionVersion version = new QuestionVersion(question, 1, "stem", 4, 3, 240,
                "Explain", QuestionVersion.ValidationState.SUGGESTED, "doc-1", 0.9, "test");
        QuestionPart partA = TestIds.withId(
                new QuestionPart(version, "a", "part a prompt", "State", 2, 0), UUID.randomUUID());
        version.addPart(partA);
        when(questionVersions.findByQuestionIdOrderByVersionDesc(QUESTION_ID))
                .thenReturn(List.of(version));

        var request = new com.syllabai.assessment.dto.StructuredSubmitRequest(
                QUESTION_ID,
                List.of(new com.syllabai.assessment.dto.PartAnswerRequest(
                        partA.id(), "attempt against unvalidated content")),
                5000L, 4, false, false);

        org.assertj.core.api.Assertions.assertThatThrownBy(
                        () -> service.submitStructured(LEARNER, request))
                .isInstanceOf(com.syllabai.shared.NotFoundException.class);
        verify(attempts, never()).save(org.mockito.ArgumentMatchers.any(Attempt.class));
        assertThat(published).isEmpty();
    }

    @Test
    @DisplayName("MCQ submit path also refuses a STRUCTURED question without a VALIDATED version")
    void mcqSubmitRefusesUnvalidatedStructured() {
        Question question = structuredQuestion();
        when(questions.findWithOptions(QUESTION_ID)).thenReturn(Optional.of(question));
        when(questionVersions.findByQuestionIdOrderByVersionDesc(QUESTION_ID))
                .thenReturn(List.of());   // no version at all — fail closed

        org.assertj.core.api.Assertions.assertThatThrownBy(
                        () -> service.submit(LEARNER, submit(OPTION_CORRECT)))
                .isInstanceOf(com.syllabai.shared.NotFoundException.class);
        verify(attempts, never()).save(org.mockito.ArgumentMatchers.any(Attempt.class));
        assertThat(published).isEmpty();
    }
```

NOTE (first-run lesson): the weak-password unit fixture uses `"abcdefgh"` — a
password that passes the DTO `@Size(min=8)` bean validation so the test truly
exercises `BootstrapAdminService.validatePasswordStrength` (a shorter one dies
at bean validation with 400 before reaching the service).

## Verification status (first rehearsal run, pre-reset — all green)

- `mvn test`: 355 tests, 0 failures (12 new bootstrap + 2 new boundary)
- Flyway V19 applied on the campaign DB; claim/consume/second-claim-409 verified
  live (the run also proved the gate REFUSES when an ADMIN already exists — a
  stale local-profile JVM had seeded demo users; cleanup done)
- Ingestion/dedup/validation/attempt checks that ran before the reset were
  green; the full rehearse.sh re-run is the first post-recovery step.
