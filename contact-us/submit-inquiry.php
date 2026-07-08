<?php
declare(strict_types=1);

const RECIPIENT_EMAIL = 'info@starreusa.com';
const FROM_EMAIL = 'no-reply@starreusa.com';
const FROM_NAME = 'Star Real Estate Website';

function clean_line(string $value, int $maxLength): string
{
    $value = strip_tags($value);
    $value = preg_replace('/[\r\n\t]+/', ' ', $value) ?? '';
    $value = trim($value);
    return substr($value, 0, $maxLength);
}

function clean_message(string $value, int $maxLength): string
{
    $value = strip_tags($value);
    $value = preg_replace("/\r\n|\r/", "\n", $value) ?? '';
    $value = preg_replace("/\n{3,}/", "\n\n", $value) ?? '';
    $value = trim($value);
    return substr($value, 0, $maxLength);
}

function post_value(string $key): string
{
    return isset($_POST[$key]) ? (string) $_POST[$key] : '';
}

function render_page(string $title, string $message, int $statusCode = 200): void
{
    http_response_code($statusCode);
    $safeTitle = htmlspecialchars($title, ENT_QUOTES, 'UTF-8');
    $safeMessage = htmlspecialchars($message, ENT_QUOTES, 'UTF-8');

    echo <<<HTML
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{$safeTitle} | Star Real Estate</title>
  <style>
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 24px;
      background: #f7f6f1;
      color: #1f2a33;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    main {
      width: min(560px, 100%);
      border: 1px solid rgba(31, 42, 51, 0.14);
      border-radius: 18px;
      background: #ffffff;
      padding: 28px;
      box-shadow: 0 18px 36px rgba(13, 59, 82, 0.12);
    }

    h1 {
      margin: 0 0 10px;
      color: #0d3b52;
      font-size: 28px;
      line-height: 1.12;
    }

    p {
      margin: 0 0 18px;
      color: #4c5963;
      line-height: 1.55;
    }

    a {
      display: inline-flex;
      border-radius: 999px;
      background: #0d3b52;
      color: #ffffff;
      padding: 10px 14px;
      text-decoration: none;
      font-weight: 800;
      font-size: 14px;
    }
  </style>
</head>
<body>
  <main>
    <h1>{$safeTitle}</h1>
    <p>{$safeMessage}</p>
    <a href="./">Back to Contact Us</a>
  </main>
</body>
</html>
HTML;
    exit;
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    render_page('Form unavailable', 'Please submit the inquiry form from the Contact Us page.', 405);
}

if (trim(post_value('website')) !== '') {
    render_page('Inquiry received', 'Thank you. The Star Real Estate team will review your message shortly.');
}

$name = clean_line(post_value('name'), 100);
$email = clean_line(post_value('email'), 180);
$phone = clean_line(post_value('phone'), 60);
$propertyType = clean_line(post_value('property_type'), 40);
$transactionType = clean_line(post_value('transaction_type'), 40);
$propertyDetails = clean_message(post_value('property_details'), 2000);

$allowedPropertyTypes = ['Residential', 'Commercial'];
$allowedTransactionTypes = ['Lease', 'Purchase'];
$errors = [];

if ($name === '') {
    $errors[] = 'name';
}

if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
    $errors[] = 'contact email';
}

if ($phone === '') {
    $errors[] = 'phone number';
}

if (!in_array($propertyType, $allowedPropertyTypes, true)) {
    $errors[] = 'property type';
}

if (!in_array($transactionType, $allowedTransactionTypes, true)) {
    $errors[] = 'lease or purchase';
}

if ($errors !== []) {
    render_page(
        'Missing information',
        'Please go back and complete the required fields: ' . implode(', ', $errors) . '.',
        422
    );
}

$submittedAt = date('Y-m-d H:i:s T');
$remoteAddress = clean_line($_SERVER['REMOTE_ADDR'] ?? 'Unavailable', 80);
$subject = 'Property Inquiry';
$body = <<<BODY
New property inquiry from starreusa.com

Name: {$name}
Contact Email: {$email}
Phone Number: {$phone}
Property Type: {$propertyType}
Lease or Purchase: {$transactionType}

Property Details:
{$propertyDetails}

Submitted: {$submittedAt}
IP Address: {$remoteAddress}
BODY;

$headers = [
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'From: ' . FROM_NAME . ' <' . FROM_EMAIL . '>',
    'Reply-To: ' . $email,
    'X-Mailer: PHP/' . phpversion(),
];

$sent = @mail(
    RECIPIENT_EMAIL,
    $subject,
    $body,
    implode("\r\n", $headers),
    '-f ' . FROM_EMAIL
);

if (!$sent) {
    render_page(
        'Message not sent',
        'The form could not send right now. Please email info@starreusa.com directly with your property details.',
        500
    );
}

render_page('Inquiry received', 'Thank you. The Star Real Estate team will review your message shortly.');
