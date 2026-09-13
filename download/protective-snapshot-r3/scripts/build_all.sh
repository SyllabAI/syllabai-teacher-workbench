#!/bin/bash
# build_all.sh — compile parser (+ classpath file) and package core (skip tests)
set -e
export JAVA_HOME=/home/z/toolchain/jdk-25.0.4.1+1
export PATH="$JAVA_HOME/bin:/home/z/toolchain/apache-maven-3.9.9/bin:$PATH"

echo "=== parser: compile ==="
cd /home/z/my-project/repos/syllabai-parser
mvn -q compile -DskipTests 2>&1 | tail -3
echo "=== parser: classpath file ==="
mvn -q dependency:build-classpath -Dmdep.outputFile=/home/z/toolchain/parser-cp.txt 2>&1 | tail -2
wc -c /home/z/toolchain/parser-cp.txt

echo "=== core: package (first run populates ~/.m2 — slow) ==="
cd /home/z/my-project/repos/syllabai-core
mvn -q package -DskipTests 2>&1 | tail -5
ls -la target/syllabai-core-0.1.0-SNAPSHOT.jar
echo "BUILD_ALL_DONE"
