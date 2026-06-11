@{
    # PSScriptAnalyzer settings for IJFW's installer scripts.
    #
    # install.ps1 is an interactive CLI installer. Several default PSSA rules
    # produce false-positives for this shape of code -- they're correct for
    # library/module authors, wrong for a user-facing shell script. We exclude
    # only the noisy-for-CLI rules and keep every rule that catches real bugs.

    Severity     = @('Error', 'Warning')
    ExcludeRules = @(
        # A CLI installer's whole job is to print to the console. Write-Host is
        # the correct tool for colored, unredirectable user-facing output --
        # exactly what this rule exists to discourage in library code. Using
        # Write-Output/Write-Information would break the interactive UX.
        'PSAvoidUsingWriteHost',

        # PSSA cannot always trace script-param usage through nested function
        # scopes, so `$Dir`, `$Yes`, etc. get flagged even though the top-level
        # flow reads them inside Get-Target, Invoke-InstallScript, etc.
        'PSReviewUnusedParameter',

        # ShouldProcess (-WhatIf/-Confirm) is a cmdlet/module-author convention.
        # install.ps1 is a standalone interactive script with its own confirm
        # flow (`-Yes`); wiring SupportsShouldProcess into internal helpers like
        # Remove-StalePosixLaunchers would add no value and change the UX.
        'PSUseShouldProcessForStateChangingFunctions',

        # Singular-noun naming is a module-export convention. These are private
        # script-internal helpers (e.g. Remove-StalePosixLaunchers), not exported
        # cmdlets, so the plural reads more naturally and exports nothing.
        'PSUseSingularNouns'
    )
}
