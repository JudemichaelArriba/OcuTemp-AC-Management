export const PASSWORD_PATTERN = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/;

export const PASSWORD_HELP_TEXT =
    'Password must be at least 8 characters and include an uppercase letter, a lowercase letter, a number, and a special character. Use only letters, numbers, and @$!%*?&.';

export interface PasswordCriteria {
    readonly minLength: boolean;
    readonly uppercase: boolean;
    readonly lowercase: boolean;
    readonly number: boolean;
    readonly specialCharacter: boolean;
    readonly allowedCharacters: boolean;
    readonly valid: boolean;
}

export function evaluatePasswordCriteria(password: string): PasswordCriteria {
    const minLength = password.length >= 8;
    const uppercase = /[A-Z]/.test(password);
    const lowercase = /[a-z]/.test(password);
    const number = /\d/.test(password);
    const specialCharacter = /[@$!%*?&]/.test(password);
    const allowedCharacters = /^[A-Za-z\d@$!%*?&]*$/.test(password);

    return {
        minLength,
        uppercase,
        lowercase,
        number,
        specialCharacter,
        allowedCharacters,
        valid: minLength
            && uppercase
            && lowercase
            && number
            && specialCharacter
            && allowedCharacters
            && PASSWORD_PATTERN.test(password),
    };
}
