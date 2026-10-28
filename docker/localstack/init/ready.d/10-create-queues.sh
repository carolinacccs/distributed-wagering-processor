#!/bin/sh
set -eu

account_id=000000000000
region=us-east-1

awslocal sqs create-queue \
  --queue-name wager-transactions-dlq.fifo \
  --attributes '{"FifoQueue":"true","ContentBasedDeduplication":"false"}' >/dev/null

dlq_arn=$(awslocal sqs get-queue-attributes \
  --queue-url "http://localhost:4566/${account_id}/wager-transactions-dlq.fifo" \
  --attribute-names QueueArn \
  --query 'Attributes.QueueArn' \
  --output text)

awslocal sqs create-queue \
  --queue-name wager-transactions.fifo \
  --attributes "{\"FifoQueue\":\"true\",\"ContentBasedDeduplication\":\"false\",\"VisibilityTimeout\":\"60\",\"RedrivePolicy\":\"{\\\"deadLetterTargetArn\\\":\\\"${dlq_arn}\\\",\\\"maxReceiveCount\\\":\\\"5\\\"}\"}" >/dev/null

awslocal sqs create-queue \
  --queue-name wager-events.fifo \
  --attributes '{"FifoQueue":"true","ContentBasedDeduplication":"false"}' >/dev/null
