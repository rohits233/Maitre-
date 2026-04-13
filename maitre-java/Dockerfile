# ── Stage 1: Build ──────────────────────────────────────────────────────────
FROM --platform=linux/amd64 maven:3.9-eclipse-temurin-21 AS build

WORKDIR /app
COPY pom.xml .
# Download dependencies first (cached layer)
RUN mvn dependency:go-offline -q

COPY src ./src
RUN mvn package -q -DskipTests

# ── Stage 2: Runtime ─────────────────────────────────────────────────────────
FROM --platform=linux/amd64 eclipse-temurin:21-jre-alpine

WORKDIR /app

# Copy the fat jar from the build stage
COPY --from=build /app/target/maitre-0.1.0.jar app.jar

# Copy greeting audio file
COPY greeting.wav greeting.wav

# Port the app listens on
EXPOSE 8080

# Environment variables (override at runtime — never bake secrets into the image)
ENV PORT=8080
ENV TWILIO_ACCOUNT_SID=""
ENV TWILIO_AUTH_TOKEN=""

ENTRYPOINT ["java", "-jar", "app.jar"]
